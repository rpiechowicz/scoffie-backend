/**
 * Sonda porównawcza wariantów N2-1 (ADR `docs/adr/catalog-change-commit-order.md`).
 * NIE jest częścią runtime. Uruchamiana na JEDNORAZOWEJ bazie z wgranym
 * wariantem triggerów (`variants/*.sql`) — patrz `run-probe.sh`.
 *
 * S1 wyścig: T1 UPDATE A (otwarta), T2 UPDATE B + COMMIT, klient bierze kursor
 *    C = MAX(revision), T1 COMMIT, czy zmiana A ma rewizję <= C (zgubiona)?
 * S2 cykl z polecenia: T1 blokuje A, T2 blokuje B, T1 chce B, T2 commituje.
 * S3 wzorzec panelu: T2 `SELECT … FOR UPDATE` na B (bez DML), T1 zmienia A,
 *    potem B; T2 zmienia B i commituje.
 *
 *   DATABASE_URL=… pnpm exec ts-node --transpile-only benchmark/catalog-change-commit-order/lock-probe.ts <etykieta>
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

type Outcome = { scenario: string; result: string; ms: number };

const prisma = new PrismaClient();

const latch = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
};

async function blockedOrDone(done: () => boolean, exclude: number[] = []) {
  for (let i = 0; i < 4_000 && !done(); i += 1) {
    const [row] = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND pid <> pg_backend_pid()`;
    if (Number(row.n) > exclude.length) return 'blocked';
    await new Promise((resolve) => setImmediate(resolve));
  }
  return done() ? 'done' : 'timeout';
}

const errCode = (error: unknown) => {
  const text = String((error as Error)?.message ?? error);
  if (text.includes('40P01') || text.includes('deadlock')) return 'DEADLOCK(40P01)';
  return `ERROR(${text.slice(0, 80)})`;
};

async function fixture() {
  const stamp = randomUUID().slice(0, 8);
  const author = await prisma.user.create({
    data: { displayName: `probe ${stamp}`, authProvider: 'DEV' },
    select: { id: true },
  });
  const house = await prisma.household.create({
    data: { name: `probe ${stamp}`, createdById: author.id },
    select: { id: true },
  });
  const mk = async (t: string) =>
    (
      await prisma.recipe.create({
        data: {
          title: `${t} ${stamp}`,
          mealType: 'DINNER',
          suitableMealTypes: ['DINNER'],
          isCatalog: true,
          isActive: true,
          authorId: author.id,
          householdId: house.id,
          nutritionKcal: 500,
          servings: 2,
        },
        select: { id: true },
      })
    ).id;
  return { a: await mk('A'), b: await mk('B') };
}

const head = async () =>
  (
    await prisma.$queryRaw<{ h: bigint }[]>`
      SELECT COALESCE(MAX("revision"), 0)::bigint AS h FROM "CatalogChange"`
  )[0].h;

async function s1(): Promise<Outcome> {
  const started = Date.now();
  const { a, b } = await fixture();
  const t1Wrote = latch();
  const t1Go = latch();
  const t1 = prisma.$transaction(
    async (tx) => {
      await tx.recipe.update({ where: { id: a }, data: { title: `A ${randomUUID()}` } });
      t1Wrote.open();
      await t1Go.opened;
    },
    { timeout: 30_000 },
  );
  await t1Wrote.opened;
  let t2Done = false;
  const t2 = prisma.recipe
    .update({ where: { id: b }, data: { title: `B ${randomUUID()}` } })
    .finally(() => (t2Done = true));
  const t2State = await blockedOrDone(() => t2Done);
  const cursor = await head();
  t1Go.open();
  await t1;
  await t2;
  const lost = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM "CatalogChange"
    WHERE "recipeId" = ${a}::uuid AND "revision" <= ${cursor}
      AND "revision" > (SELECT MIN("revision") FROM "CatalogChange" WHERE "recipeId" = ${a}::uuid)`;
  return {
    scenario: 'S1 wyścig',
    result: `${Number(lost[0].n) > 0 ? 'ZGUBIONA (rewizja A <= kursor)' : 'OK (A > kursor)'}; T2 ${t2State}`,
    ms: Date.now() - started,
  };
}

async function cycle(label: string, adminPattern: boolean): Promise<Outcome> {
  const started = Date.now();
  const { a, b } = await fixture();
  const t1HasA = latch();
  const t1GoB = latch();
  const t2HasB = latch();
  const t2GoCommit = latch();
  const results: Record<string, string> = {};
  let t1Done = false;
  let t2Done = false;

  const t1 = prisma
    .$transaction(
      async (tx) => {
        await tx.recipe.update({ where: { id: a }, data: { title: `A ${randomUUID()}` } });
        t1HasA.open();
        await t1GoB.opened;
        await tx.recipe.update({ where: { id: b }, data: { title: `B1 ${randomUUID()}` } });
      },
      { timeout: 30_000, maxWait: 10_000 },
    )
    .then(
      () => (results.t1 = 'COMMIT'),
      (e) => (results.t1 = errCode(e)),
    )
    .finally(() => (t1Done = true));
  await t1HasA.opened;

  const t2 = prisma
    .$transaction(
      async (tx) => {
        if (adminPattern) {
          await tx.$queryRaw(Prisma.sql`SELECT 1 FROM "Recipe" WHERE "id" = ${b}::uuid FOR UPDATE`);
          t2HasB.open();
          await t2GoCommit.opened;
          await tx.recipe.update({ where: { id: b }, data: { title: `B2 ${randomUUID()}` } });
        } else {
          await tx.recipe.update({ where: { id: b }, data: { title: `B2 ${randomUUID()}` } });
          t2HasB.open();
          await t2GoCommit.opened;
        }
      },
      { timeout: 30_000, maxWait: 10_000 },
    )
    .then(
      () => (results.t2 = 'COMMIT'),
      (e) => (results.t2 = errCode(e)),
    )
    .finally(() => (t2Done = true));

  // T2 albo zdobyła B, albo stoi (wariant A/B: czeka na zamek katalogu z B w ręku).
  await Promise.race([t2HasB.opened, blockedOrDone(() => t2Done)]);
  t1GoB.open();
  await blockedOrDone(() => t1Done);
  t2GoCommit.open();
  await Promise.all([t1, t2]);
  return {
    scenario: label,
    result: `T1=${results.t1} T2=${results.t2}`,
    ms: Date.now() - started,
  };
}

async function main() {
  const label = process.argv[2] ?? '?';
  const out: Outcome[] = [];
  for (let i = 0; i < 3; i += 1) out.push(await s1());
  for (let i = 0; i < 3; i += 1) out.push(await cycle('S2 cykl z polecenia', false));
  for (let i = 0; i < 3; i += 1) out.push(await cycle('S3 wzorzec panelu (FOR UPDATE)', true));
  for (const o of out) console.log(`${label}\t${o.scenario}\t${o.result}\t${o.ms} ms`);
  await prisma.$disconnect();
}

void main();
