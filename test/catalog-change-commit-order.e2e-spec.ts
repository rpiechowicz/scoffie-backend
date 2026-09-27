import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { OpsController } from '../src/observability/ops.controller';
import {
  CatalogChangesPage,
  CatalogSyncService,
  parseCatalogRevision,
} from '../src/recipes/catalog-sync.service';

/**
 * Kolejność commitów w logu `CatalogChange` (workstream N2-1).
 *
 * Niezmiennik: jeżeli klient dostał kursor C, żadna transakcja katalogowa,
 * która stanie się widoczna później, nie może mieć rewizji <= C.
 *
 * Bez zegarów: transakcje trzymane otwarte na zatrzaskach (obietnice), a
 * „T2 czeka na blokadę” rozpoznajemy po `pg_stat_activity`, nie po czasie.
 */
type DeltaOk = Extract<CatalogChangesPage, { mode: 'DELTA' }>;

jest.setTimeout(60_000);

describe('CatalogChange — kolejność rewizji = kolejność commitów (N2-1)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let sync: CatalogSyncService;
  let authorId: string;
  let householdId: string;
  const recipes: string[] = [];

  /**
   * Osobna pula na transakcje trzymane otwarte (`hold`). Testy 4/9 i 4b
   * trzymają 10 naraz, a czytelnik (delta, `pg_stat_activity`) potrzebuje
   * połączenia z puli aplikacji. Domyślna pula Prismy to 2 × CPU + 1 — na
   * runnerze CI (4 CPU) 9 połączeń: dziesiąta transakcja czekała na
   * połączenie, a test na nią, do timeoutu 60 s. Jawny limit uniezależnia
   * test od liczby rdzeni maszyny.
   */
  const WRITER_POOL = 12;
  let writers: PrismaClient;
  const withConnectionLimit = (raw: string, limit: number) => {
    const url = new URL(raw);
    url.searchParams.set('connection_limit', String(limit));
    return url.toString();
  };

  const latch = () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    return { open, opened };
  };

  const delta = async (sinceRevision: string) => {
    const page = (await sync.changes({ sinceRevision, limit: 500 })) as DeltaOk;
    expect(page.mode).toBe('DELTA');
    expect(page.nextCursor).toBeNull();
    return {
      revision: page.revision,
      ids: [...page.upserts.map((item) => item.id), ...page.tombstones],
    };
  };

  const revisionOf = (token: string) => parseCatalogRevision(token)!.revision;

  const LOCK_NS = 1667331187; // 0x63617473 'cats' — jak w migracji

  type Tx = Prisma.TransactionClient;

  const outcome = (e: unknown) => {
    const text = String((e as Error)?.message ?? e);
    if (text.includes('ROLLBACK-ZADANY')) return 'ROLLBACK';
    if (text.includes('40P01') || text.includes('deadlock')) return '40P01';
    return `ERROR ${text.slice(0, 160)}`;
  };

  /**
   * Transakcja trzymana otwarta: `ready` po wykonaniu `body`, potem czeka na
   * `finish('commit' | 'rollback')`. `result` = 'COMMIT' | 'ROLLBACK' | '40P01' | błąd.
   */
  const hold = (body: (tx: Tx) => Promise<void>) => {
    const ready = latch();
    let decide!: (how: 'commit' | 'rollback') => void;
    const decision = new Promise<'commit' | 'rollback'>((r) => (decide = r));
    let settled = false;
    const result = writers
      .$transaction(
        async (tx) => {
          await body(tx);
          ready.open();
          if ((await decision) === 'rollback') {
            throw new Error('ROLLBACK-ZADANY');
          }
        },
        { timeout: 45_000, maxWait: 10_000 },
      )
      .then(() => 'COMMIT', outcome)
      .finally(() => (settled = true));
    return {
      ready: ready.opened,
      finish: (how: 'commit' | 'rollback') => decide(how),
      result,
      settled: () => settled,
    };
  };

  const touch = (tx: Tx | PrismaService, id: string) =>
    tx.recipe.update({
      where: { id },
      data: { title: `zmiana ${randomUUID()}` },
    });

  /** Łańcuch delt od kursora do bieżącej głowy — jak klient. */
  const chase = async (from: string) => {
    let cursor = from;
    const ids = new Set<string>();
    for (let i = 0; i < 10; i += 1) {
      const d = await delta(cursor);
      d.ids.forEach((id) => ids.add(id));
      if (d.revision === cursor) break;
      cursor = d.revision;
    }
    return { cursor, ids };
  };

  const revisionsAfter = async (recipeId: string, after: bigint) =>
    (await logRevisions(prisma, recipeId)).filter((r) => r > after);

  /** Rewizje wpisów logu dla przepisu (widoczne dla wołającego). */
  const logRevisions = async (
    client: Pick<PrismaService, '$queryRaw'>,
    recipeId: string,
  ) =>
    (
      await client.$queryRaw<{ revision: bigint }[]>`
        SELECT "revision" FROM "CatalogChange"
        WHERE "recipeId" = ${recipeId}::uuid ORDER BY "revision"`
    ).map((row) => row.revision);

  const createCatalogRecipe = async (title: string) => {
    const row = await prisma.recipe.create({
      data: {
        title,
        mealType: 'DINNER',
        suitableMealTypes: ['DINNER'],
        isCatalog: true,
        isActive: true,
        authorId,
        householdId,
        nutritionKcal: 600,
        servings: 2,
      },
      select: { id: true },
    });
    recipes.push(row.id);
    return row.id;
  };

  /** Czeka (warunkiem, nie zegarem), aż ktoś w tej bazie stoi na blokadzie. */
  const waitUntilBlocked = async (done: () => boolean) => {
    for (let i = 0; i < 2_000 && !done(); i += 1) {
      const [row] = await prisma.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*) AS "waiting" FROM pg_stat_activity
        WHERE "datname" = current_database()
          AND "wait_event_type" IN ('Lock')
          AND "pid" <> pg_backend_pid()`;
      if (Number(row.waiting) > 0) return 'blocked' as const;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return done() ? ('done' as const) : ('timeout' as const);
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    sync = moduleRef.get(CatalogSyncService);
    writers = new PrismaClient({
      datasourceUrl: withConnectionLimit(
        process.env.DATABASE_URL!,
        WRITER_POOL,
      ),
    });
    const stamp = `${Date.now()}-${randomUUID().slice(0, 6)}`;
    authorId = (
      await prisma.user.create({
        data: {
          displayName: `Commit order ${stamp}`,
          email: `commit-order-${stamp}@catalog.local`,
          authProvider: 'DEV',
        },
        select: { id: true },
      })
    ).id;
    householdId = (
      await prisma.household.create({
        data: { name: `Katalog commit order ${stamp}`, createdById: authorId },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.recipe.deleteMany({ where: { householdId } });
    await prisma.household.deleteMany({ where: { id: householdId } });
    await prisma.user.deleteMany({ where: { id: authorId } });
    await writers.$disconnect();
    await moduleRef.close();
  });

  it('0. RACE: T1 dostaje niższą rewizję, T2 commituje pierwsza — zmiana T1 nie ginie z delty', async () => {
    const a = await createCatalogRecipe(`Race A ${randomUUID()}`);
    const b = await createCatalogRecipe(`Race B ${randomUUID()}`);
    const start = await sync.currentRevision();

    const t1Wrote = latch();
    const t1MayCommit = latch();
    let t1OwnRevisions: bigint[] = [];

    // (1)–(3) T1: UPDATE przepisu A, rewizja (jeśli już jest) widoczna tylko
    // dla T1; T1 NIE commituje.
    const t1 = prisma.$transaction(
      async (tx) => {
        await tx.recipe.update({
          where: { id: a },
          data: { title: `A zmienione przez T1 ${randomUUID()}` },
        });
        t1OwnRevisions = await logRevisions(tx, a);
        t1Wrote.open();
        await t1MayCommit.opened;
      },
      { timeout: 30_000 },
    );
    await t1Wrote.opened;

    // (4)–(6) T2: UPDATE przepisu B i COMMIT. Z poprawką szeregującą commit
    // T2 może czekać na T1 — wtedy nie czekamy na jego koniec.
    let t2Done = false;
    const t2 = prisma.recipe
      .update({
        where: { id: b },
        data: { title: `B zmienione przez T2 ${randomUUID()}` },
      })
      .finally(() => (t2Done = true));
    const t2State = await waitUntilBlocked(() => t2Done);
    expect(t2State).not.toBe('timeout');

    // (7) Klient synchronizuje się TERAZ i zapisuje kursor C.
    const first = await delta(start);

    // (8) T1 commituje; T2 kończy się (jeśli czekał).
    t1MayCommit.open();
    await t1;
    await t2;

    // (9) Kolejna delta od C.
    const second = await delta(first.revision);
    const delivered = new Set([...first.ids, ...second.ids]);

    // Diagnostyka do raportu: kolejność rewizji wobec kursora C.
    const aRevisions = await logRevisions(prisma, a);
    const bRevisions = await logRevisions(prisma, b);
    console.log(
      `[N2-1] T1 widziała swoje rewizje A przed commitem: [${t1OwnRevisions.join(',')}]; ` +
        `po wszystkim A=[${aRevisions.join(',')}] B=[${bRevisions.join(',')}]; ` +
        `kursor C=${revisionOf(first.revision)}; T2 ${t2State === 'blocked' ? 'czekała na T1' : 'nie czekała'}`,
    );

    // (10) Niezmiennik: obie zmiany dotarły; każda rewizja A widoczna PO
    // wydaniu kursora C musi być > C.
    expect(delivered.has(b)).toBe(true);
    expect(delivered.has(a)).toBe(true);
    const cursor = revisionOf(first.revision);
    const aFromT1 = aRevisions.filter((r) => r > revisionOf(start));
    expect(aFromT1.length).toBeGreaterThan(0);
    if (!first.ids.includes(a)) {
      expect(aFromT1.every((revision) => revision > cursor)).toBe(true);
    }
  });

  it('1. commit czeka, gdy inna transakcja jest w fazie commitu (trzyma zamek); kursor nie przeskakuje jej numeru', async () => {
    const a = await createCatalogRecipe(`Zamek A ${randomUUID()}`);
    const start = await sync.currentRevision();
    // „Transakcja w fazie commitu” = sesja trzymająca zamek numerowania.
    const holder = hold(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NS}::int, 1)`;
    });
    await holder.ready;
    let t2Done = false;
    const t2 = touch(prisma, a).finally(() => (t2Done = true));
    expect(await waitUntilBlocked(() => t2Done)).toBe('blocked');
    // T2 czeka na zamek: jej zmiana jeszcze niewidoczna i BEZ numeru.
    const mid = await delta(start);
    expect(mid.ids).not.toContain(a);
    holder.finish('commit');
    expect(await holder.result).toBe('COMMIT');
    await t2;
    const after = await chase(mid.revision);
    expect(after.ids.has(a)).toBe(true);
    const cursor = revisionOf(mid.revision);
    const revs = await revisionsAfter(a, revisionOf(start));
    expect(revs.length).toBeGreaterThan(0);
    expect(revs.every((r) => r > cursor)).toBe(true);
  });

  it('2. ROLLBACK T1: brak wpisu w logu, T2 dostarczona', async () => {
    const a = await createCatalogRecipe(`Rb1 A ${randomUUID()}`);
    const b = await createCatalogRecipe(`Rb1 B ${randomUUID()}`);
    const start = await sync.currentRevision();
    const t1 = hold(async (tx) => {
      await touch(tx, a);
    });
    await t1.ready;
    await touch(prisma, b);
    const first = await delta(start);
    t1.finish('rollback');
    expect(await t1.result).toBe('ROLLBACK');
    const later = await chase(first.revision);
    expect(first.ids).toContain(b);
    expect(first.ids).not.toContain(a);
    expect(later.ids.has(a)).toBe(false);
    expect(await revisionsAfter(a, revisionOf(start))).toEqual([]);
  });

  it('3. ROLLBACK T2: T1 dostarczona po swoim commicie', async () => {
    const a = await createCatalogRecipe(`Rb2 A ${randomUUID()}`);
    const b = await createCatalogRecipe(`Rb2 B ${randomUUID()}`);
    const start = await sync.currentRevision();
    const t1 = hold(async (tx) => {
      await touch(tx, a);
    });
    const t2 = hold(async (tx) => {
      await touch(tx, b);
    });
    await Promise.all([t1.ready, t2.ready]);
    t2.finish('rollback');
    expect(await t2.result).toBe('ROLLBACK');
    const first = await delta(start);
    t1.finish('commit');
    expect(await t1.result).toBe('COMMIT');
    const later = await chase(first.revision);
    expect(later.ids.has(a)).toBe(true);
    expect(later.ids.has(b)).toBe(false);
    expect(await revisionsAfter(b, revisionOf(start))).toEqual([]);
  });

  it('4./9. 10 równoległych zapisujących, commity w odwrotnej kolejności, delta między commitami — nic nie ginie', async () => {
    const ids = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createCatalogRecipe(`Rój ${i} ${randomUUID()}`),
      ),
    );
    const start = await sync.currentRevision();
    const txs = ids.map((id) =>
      hold(async (tx) => {
        await touch(tx, id);
      }),
    );
    await Promise.all(txs.map((t) => t.ready));
    let cursor = start;
    const delivered = new Set<string>();
    for (let i = txs.length - 1; i >= 0; i -= 1) {
      const before = revisionOf(cursor);
      txs[i].finish('commit');
      expect(await txs[i].result).toBe('COMMIT');
      // Numer transakcji i powstał PO wydaniu kursora, więc jest > kursor.
      const revs = await revisionsAfter(ids[i], revisionOf(start));
      expect(revs.every((r) => r > before)).toBe(true);
      const d = await delta(cursor);
      d.ids.forEach((id) => delivered.add(id));
      cursor = d.revision;
    }
    expect([...delivered].sort()).toEqual([...ids].sort());
  });

  it('4b. 10 zapisujących commituje RÓWNOCZEŚNIE, klient ciągnie deltę w pętli — łańcuch delt dowozi wszystko; każda transakcja = ciągły blok', async () => {
    const ids = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createCatalogRecipe(`Burza ${i} ${randomUUID()}`),
      ),
    );
    const start = await sync.currentRevision();
    const txs = ids.map((id) =>
      hold(async (tx) => {
        await touch(tx, id);
        await touch(tx, id);
      }),
    );
    await Promise.all(txs.map((t) => t.ready));
    const delivered = new Set<string>();
    let cursor = start;
    txs.forEach((t) => t.finish('commit'));
    while (txs.some((t) => !t.settled())) {
      const d = await delta(cursor);
      d.ids.forEach((id) => delivered.add(id));
      cursor = d.revision;
    }
    expect(await Promise.all(txs.map((t) => t.result))).toEqual(
      Array(10).fill('COMMIT'),
    );
    const rest = await chase(cursor);
    rest.ids.forEach((id) => delivered.add(id));
    expect(ids.every((id) => delivered.has(id))).toBe(true);
    for (const id of ids) {
      const revs = await revisionsAfter(id, revisionOf(start));
      expect(revs).toHaveLength(2);
      expect(revs[1] - revs[0]).toBe(1n);
    }
  });

  it('5./8. Recipe + RecipeIngredient + kilka przepisów w JEDNEJ transakcji: ciągły blok rewizji, całość dostarczona', async () => {
    const a = await createCatalogRecipe(`Multi A ${randomUUID()}`);
    const b = await createCatalogRecipe(`Multi B ${randomUUID()}`);
    const ingredient = await prisma.ingredient.findFirstOrThrow({
      select: { id: true },
    });
    const start = await sync.currentRevision();
    const t1 = hold(async (tx) => {
      await touch(tx, a);
      await tx.recipeIngredient.create({
        data: {
          recipeId: a,
          ingredientId: ingredient.id,
          name: 'składnik testowy',
          amount: 100,
          unit: 'g',
          normalizedAmount: 100,
          normalizedUnit: 'g',
          department: 'inne',
        },
      });
      await touch(tx, b);
      await touch(tx, a);
    });
    await t1.ready;
    await createCatalogRecipe(`Multi przeszkadzacz ${randomUUID()}`);
    const first = await delta(start);
    t1.finish('commit');
    expect(await t1.result).toBe('COMMIT');
    const later = await chase(first.revision);
    expect(later.ids.has(a) && later.ids.has(b)).toBe(true);
    const cut = revisionOf(first.revision);
    const all = [
      ...(await revisionsAfter(a, cut)),
      ...(await revisionsAfter(b, cut)),
    ].sort((x, y) => (x < y ? -1 : 1));
    expect(all.length).toBe(4); // A, składnik A, B, A
    expect(all[all.length - 1] - all[0]).toBe(BigInt(all.length - 1));
  });

  it('6. DELETE przepisu katalogu zatwierdzony później → tombstone dostarczony', async () => {
    const a = await createCatalogRecipe(`Del A ${randomUUID()}`);
    const b = await createCatalogRecipe(`Del B ${randomUUID()}`);
    const start = await sync.currentRevision();
    const t1 = hold(async (tx) => {
      await tx.recipe.delete({ where: { id: a } });
    });
    await t1.ready;
    await touch(prisma, b);
    const first = await delta(start);
    t1.finish('commit');
    expect(await t1.result).toBe('COMMIT');
    const page = (await sync.changes({
      sinceRevision: first.revision,
      limit: 500,
    })) as DeltaOk;
    expect(page.tombstones).toContain(a);
  });

  it('7. bulk: createMany 200 + updateMany w otwartej transakcji i równoległy zapis → wszystkie 200 dostarczone po commicie', async () => {
    const ids = Array.from({ length: 200 }, () => randomUUID());
    const b = await createCatalogRecipe(`Bulk B ${randomUUID()}`);
    const start = await sync.currentRevision();
    const t1 = hold(async (tx) => {
      await tx.recipe.createMany({
        data: ids.map((id, i) => ({
          id,
          title: `Bulk ${i} ${randomUUID()}`,
          mealType: 'DINNER' as const,
          suitableMealTypes: ['DINNER' as const],
          isCatalog: true,
          isActive: true,
          authorId,
          householdId,
          nutritionKcal: 500,
          servings: 2,
        })),
      });
      await tx.$executeRaw(
        Prisma.sql`UPDATE "Recipe" SET "title" = "title" || '!' WHERE "id" = ANY(${ids}::uuid[])`,
      );
    });
    await t1.ready;
    await touch(prisma, b);
    const first = await delta(start);
    expect(first.ids).toContain(b);
    t1.finish('commit');
    expect(await t1.result).toBe('COMMIT');
    recipes.push(...ids);
    const later = await chase(first.revision);
    expect(ids.every((id) => later.ids.has(id))).toBe(true);
  });

  it('10. „pruning” (minRevision = głowa) w trakcie otwartej transakcji: jej numer i tak > minRevision; stary kursor → RESET_REQUIRED', async () => {
    const a = await createCatalogRecipe(`Prune A ${randomUUID()}`);
    const [state] = await prisma.$queryRaw<{ minRevision: bigint }[]>`
      SELECT "minRevision" FROM "CatalogSyncState" WHERE "id" = 1`;
    const old = await sync.currentRevision();
    const t1 = hold(async (tx) => {
      await touch(tx, a);
    });
    await t1.ready;
    try {
      await touch(prisma, await createCatalogRecipe(`Prune B ${randomUUID()}`));
      const pruneAt = await sync.currentRevision();
      await prisma.$executeRaw`
        UPDATE "CatalogSyncState" SET "minRevision" = ${revisionOf(pruneAt)} WHERE "id" = 1`;
      t1.finish('commit');
      expect(await t1.result).toBe('COMMIT');
      const stale = await sync.changes({ sinceRevision: old, limit: 10 });
      expect(stale.mode).toBe('RESET_REQUIRED');
      expect((stale as { reason: string }).reason).toBe('REVISION_PRUNED');
      const later = await chase(pruneAt);
      expect(later.ids.has(a)).toBe(true);
      const revs = await revisionsAfter(a, revisionOf(pruneAt));
      expect(revs.length).toBeGreaterThan(0);
    } finally {
      await prisma.$executeRaw`
        UPDATE "CatalogSyncState" SET "minRevision" = ${state.minRevision} WHERE "id" = 1`;
    }
  });

  it('11. snapshot rozpoczęty, gdy T1 otwarta: znacznik + późniejsza delta dowożą zmianę T1', async () => {
    const a = await createCatalogRecipe(`Snap A ${randomUUID()}`);
    const title = `Snap A po zmianie ${randomUUID()}`;
    const t1 = hold(async (tx) => {
      await tx.recipe.update({ where: { id: a }, data: { title } });
    });
    await t1.ready;
    const firstPage = await sync.snapshot({ limit: 50 });
    expect(firstPage.mode).toBe('SNAPSHOT');
    const marker = (firstPage as { revision: string }).revision;
    t1.finish('commit');
    expect(await t1.result).toBe('COMMIT');
    const page = (await sync.changes({
      sinceRevision: marker,
      limit: 500,
    })) as DeltaOk;
    expect(page.upserts.find((u) => u.id === a)?.title).toBe(title);
  });

  it('12. kursor z nieznanej epoki / z przyszłości → RESET_REQUIRED (protokół bez zmian)', async () => {
    const head = await sync.currentRevision();
    const epoch = head.slice(0, head.lastIndexOf('.'));
    const foreign = `${randomUUID()}.${revisionOf(head)}`;
    const future = `${epoch}.${revisionOf(head) + 1000n}`;
    const a = await sync.changes({ sinceRevision: foreign, limit: 10 });
    const b = await sync.changes({ sinceRevision: future, limit: 10 });
    expect(a.mode).toBe('RESET_REQUIRED');
    expect((a as { reason: string }).reason).toBe('UNKNOWN_REVISION');
    expect(b.mode).toBe('RESET_REQUIRED');
    expect((b as { reason: string }).reason).toBe('FUTURE_REVISION');
  });

  it('13. SAVEPOINT: zmiana wycofana do punktu zapisu nie trafia do logu, reszta transakcji tak', async () => {
    const a = await createCatalogRecipe(`Sp A ${randomUUID()}`);
    const b = await createCatalogRecipe(`Sp B ${randomUUID()}`);
    const start = await sync.currentRevision();
    await prisma.$transaction(async (tx) => {
      await touch(tx, a);
      await tx.$executeRawUnsafe('SAVEPOINT sp1');
      await touch(tx, b);
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT sp1');
    });
    const d = await chase(start);
    expect(d.ids.has(a)).toBe(true);
    expect(d.ids.has(b)).toBe(false);
    expect(await revisionsAfter(b, revisionOf(start))).toEqual([]);
  });

  it('14. KONFLIKT KOLEJNOŚCI BLOKAD (cykl z polecenia i wzorzec panelu, ×3): brak 40P01, obie zatwierdzone, nic nie ginie', async () => {
    for (const adminPattern of [false, true, false, true, false, true]) {
      const a = await createCatalogRecipe(`Cykl A ${randomUUID()}`);
      const b = await createCatalogRecipe(`Cykl B ${randomUUID()}`);
      const start = await sync.currentRevision();
      const t1HasA = latch();
      const t1GoB = latch();
      let t1Done = false;
      // T1: blokuje A, potem chce B.
      const t1 = prisma
        .$transaction(
          async (tx) => {
            await touch(tx, a);
            t1HasA.open();
            await t1GoB.opened;
            await touch(tx, b);
          },
          { timeout: 45_000 },
        )
        .then(() => 'COMMIT', outcome)
        .finally(() => (t1Done = true));
      await t1HasA.opened;
      // T2: blokuje B (UPDATE albo, jak panel, SELECT … FOR UPDATE i UPDATE).
      const t2 = hold(async (tx) => {
        if (adminPattern) {
          await tx.$queryRaw(
            Prisma.sql`SELECT 1 FROM "Recipe" WHERE "id" = ${b}::uuid FOR UPDATE`,
          );
        }
        await touch(tx, b);
      });
      // Z zamkiem w chwili DML (wariant A/B) T2 staje już tutaj — wtedy nie
      // czekamy na `ready`, tylko domykamy cykl, żeby padł jawnie (40P01).
      await Promise.race([t2.ready, waitUntilBlocked(() => t2.settled())]);
      t1GoB.open();
      // T1 stoi na wierszu B trzymanym przez T2 — to jest miejsce, w którym
      // zamek w chwili DML (wariant A/B z ADR) domykał cykl.
      await waitUntilBlocked(() => t1Done);
      t2.finish('commit');
      expect({ t1: await t1, t2: await t2.result }).toEqual({
        t1: 'COMMIT',
        t2: 'COMMIT',
      });
      const d = await chase(start);
      expect(d.ids.has(a) && d.ids.has(b)).toBe(true);
    }
  });

  it('15. naruszenie reguły operacyjnej (DML katalogu + LOCK TABLE "CatalogChange" w jednej transakcji): cykl WYKRYTY (40P01 dla jednej), bez cichej utraty', async () => {
    const a = await createCatalogRecipe(`Regula A ${randomUUID()}`);
    const b = await createCatalogRecipe(`Regula B ${randomUUID()}`);
    const start = await sync.currentRevision();
    const hHasLock = latch();
    const hGo = latch();
    // H symuluje fazę commitu: trzyma zamek numerowania, potem dopisuje do logu.
    const h = prisma
      .$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NS}::int, 1)`;
          hHasLock.open();
          await hGo.opened;
          await tx.$executeRaw`INSERT INTO "CatalogChange" ("recipeId", "kind") VALUES (${b}::uuid, 'UPSERT')`;
        },
        { timeout: 45_000 },
      )
      .then(() => 'COMMIT', outcome);
    await hHasLock.opened;
    // X łamie regułę: zmiana katalogu + SHARE na logu, potem COMMIT, w którym
    // odroczony trigger czeka na zamek H.
    let xDone = false;
    const x = prisma
      .$transaction(
        async (tx) => {
          await touch(tx, a);
          await tx.$executeRawUnsafe(
            'LOCK TABLE "CatalogChange" IN SHARE MODE',
          );
        },
        { timeout: 45_000 },
      )
      .then(() => 'COMMIT', outcome)
      .finally(() => (xDone = true));
    expect(await waitUntilBlocked(() => xDone)).toBe('blocked');
    hGo.open();
    const [hResult, xResult] = await Promise.all([h, x]);
    expect([hResult, xResult].filter((r) => r === '40P01')).toHaveLength(1);
    expect([hResult, xResult].filter((r) => r === 'COMMIT')).toHaveLength(1);
    const d = await chase(start);
    if (xResult === 'COMMIT') expect(d.ids.has(a)).toBe(true);
    else expect(await revisionsAfter(a, revisionOf(start))).toEqual([]);
    if (hResult === 'COMMIT') expect(d.ids.has(b)).toBe(true);
  });

  it('16. obserwowalność: /ops/metrics ma catalogSync.head = bieżąca rewizja i licznik deadlocków całej bazy', async () => {
    await createCatalogRecipe(`Metryki ${randomUUID()}`);
    const metrics = await moduleRef.get(OpsController).getMetrics();
    const head = await sync.currentRevision();
    expect(metrics.catalogSync.head).toBe(Number(revisionOf(head)));
    expect(typeof metrics.catalogSync.databaseDeadlocks).toBe('number');
  });

  it('17. strażnik założeń: oba triggery logu są DEFERRABLE INITIALLY DEFERRED', async () => {
    const rows = await prisma.$queryRaw<
      { tgname: string; tgdeferrable: boolean; tginitdeferred: boolean }[]
    >`SELECT "tgname", "tgdeferrable", "tginitdeferred" FROM pg_trigger
      WHERE "tgname" IN ('Recipe_catalog_change', 'RecipeIngredient_catalog_change')
      ORDER BY "tgname"`;
    expect(rows).toEqual([
      {
        tgname: 'RecipeIngredient_catalog_change',
        tgdeferrable: true,
        tginitdeferred: true,
      },
      {
        tgname: 'Recipe_catalog_change',
        tgdeferrable: true,
        tginitdeferred: true,
      },
    ]);
  });
});
