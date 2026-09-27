import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
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
});
