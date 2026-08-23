/**
 * Narzędzie naprawcze do `PlanItem.plannedServings` — czyli do pytania „ile
 * porcji przepisu naprawdę gotujemy w tym slocie".
 *
 * NIE jest to główna droga backfillu. Właściwe wartości wstawia sama migracja
 * `20260823100000_plan_item_planned_servings`, bo razem z nią wchodzi zmiana
 * wagi pozycji na liście zakupów i między `migrate deploy` a ręcznym
 * uruchomieniem skryptu każdy istniejący tydzień kupowałby połowę składników.
 * Ten skrypt zostaje dla baz, które przeszły przez migrację bez UPDATE-u
 * (środowiska zmigrowane wcześniejszą wersją pliku, ręczne `ADD COLUMN`,
 * przywrócone zrzuty) oraz jako dry-run do podejrzenia, co backfill wyliczyłby
 * dzisiaj.
 *
 * Reguła jest ta sama co w migracji i w `resolvePlannedServings`: porcje z
 * audytorium posiłku — liczby uczestników, a dla dania „Wspólne" (brak
 * uczestników) z liczby domowników. Zawsze klamrowane do 1..12.
 *
 * Czego ten backfill NIE zmienia: licznika kalorii. Udział jednej osoby to
 * `plannedServings / liczba jedzących`, a skrypt ustawia licznik równy
 * mianownikowi, więc wychodzi dokładnie 1.0 porcji na osobę — tyle samo, ile
 * aplikacja pokazywała dotąd. Zmienia się lista zakupów: składniki skalują się
 * przez `plannedServings / recipe.servings`, więc obiad dla czterech osób
 * ugotowany z przepisu na dwie zacznie wreszcie zamawiać podwójne zakupy.
 *
 * Idempotencja stoi na dwóch filtrach. Pierwszy to `plannedServings = 1`:
 * wiersz ustawiony stepperem na cokolwiek innego wypada z zapytania. Drugi to
 * data utworzenia sprzed migracji — bez niego skrypt nadpisywałby świadomie
 * wybraną JEDNĄ porcję w posiłkach zaplanowanych już po wdrożeniu, bo jedynki
 * domyślnej od wybranej nie da się odróżnić (osobnej flagi „ruszane ręcznie"
 * nie wprowadzamy dla jednorazowego backfillu). Wiersze sprzed migracji tego
 * problemu nie mają — tam jedynka na pewno pochodzi z `DEFAULT`.
 *
 * Użycie:
 *   pnpm plans:backfill:servings              # dry-run, tylko raport
 *   pnpm plans:backfill:servings -- --write   # zapis
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const MIN_SERVINGS = 1;
const MAX_SERVINGS = 12;

/**
 * Znacznik czasu migracji `20260823100000_plan_item_planned_servings`. Wszystko,
 * co powstało później, ma porcje ustawione świadomie — przez regułę auto na
 * serwerze albo przez stepper — więc backfill nie ma tam czego naprawiać.
 */
const MIGRATION_CUTOFF = new Date('2026-08-23T10:00:00Z');

const DAY_LABELS: Record<string, string> = {
  MON: 'Poniedziałek',
  TUE: 'Wtorek',
  WED: 'Środa',
  THU: 'Czwartek',
  FRI: 'Piątek',
  SAT: 'Sobota',
  SUN: 'Niedziela',
};

const MEAL_TYPE_LABELS: Record<string, string> = {
  BREAKFAST: 'Śniadanie',
  SECOND_BREAKFAST: 'II śniadanie',
  LUNCH: 'Obiad',
  AFTERNOON_SNACK: 'Podwieczorek',
  DINNER: 'Kolacja',
  SNACK: 'Przekąska',
};

function clampServings(value: number): number {
  return Math.min(MAX_SERVINGS, Math.max(MIN_SERVINGS, Math.trunc(value)));
}

async function main() {
  const write = process.argv.includes('--write');

  const items = await prisma.planItem.findMany({
    where: {
      plannedServings: MIN_SERVINGS,
      createdAt: { lt: MIGRATION_CUTOFF },
    },
    select: {
      id: true,
      dayOfWeek: true,
      mealType: true,
      recipe: { select: { title: true } },
      weeklyPlan: { select: { weekStart: true, householdId: true } },
      _count: { select: { participants: true } },
    },
    orderBy: [
      { weeklyPlan: { weekStart: 'asc' } },
      { dayOfWeek: 'asc' },
      { mealType: 'asc' },
    ],
  });

  // Jedno zapytanie na wszystkie gospodarstwa naraz, bo itemów planu bywają
  // tysiące, a gospodarstw kilka — liczenie domowników per wiersz zrobiłoby z
  // tego N+1 bez żadnego zysku.
  const householdIds = [
    ...new Set(items.map((item) => item.weeklyPlan.householdId)),
  ];
  const memberships = await prisma.membership.groupBy({
    by: ['householdId'],
    where: { householdId: { in: householdIds } },
    _count: { _all: true },
  });
  const memberCounts = new Map(
    memberships.map((row) => [row.householdId, row._count._all]),
  );

  let changed = 0;
  const perServings = new Map<number, number>();

  for (const item of items) {
    const participantCount = item._count.participants;
    const memberCount = memberCounts.get(item.weeklyPlan.householdId) ?? 1;
    const eaters = participantCount > 0 ? participantCount : memberCount;
    const plannedServings = clampServings(eaters);

    perServings.set(
      plannedServings,
      (perServings.get(plannedServings) ?? 0) + 1,
    );

    if (plannedServings === MIN_SERVINGS) continue;
    changed += 1;

    const source =
      participantCount > 0
        ? `uczestnicy: ${participantCount}`
        : `wspólne, domownicy: ${memberCount}`;
    const week = item.weeklyPlan.weekStart.toISOString().slice(0, 10);
    console.log(
      `${week}  ${DAY_LABELS[item.dayOfWeek].padEnd(13)} ${MEAL_TYPE_LABELS[item.mealType].padEnd(13)} ${item.recipe.title.slice(0, 40).padEnd(42)} 1 → ${plannedServings} (${source})`,
    );

    if (write) {
      await prisma.planItem.update({
        where: { id: item.id },
        data: { plannedServings },
      });
    }
  }

  console.log('');
  console.log(`Itemów sprzed migracji z 1: ${items.length}`);
  console.log(`Do zmiany:                 ${changed}`);
  console.log(`Zostaje przy 1 porcji:     ${items.length - changed}`);
  for (const [servings, count] of [...perServings].sort(
    (a, b) => a[0] - b[0],
  )) {
    console.log(`  ${String(servings).padStart(2)} porcji  ${count} itemów`);
  }
  console.log(
    write
      ? '\nZapisano.'
      : '\nDRY RUN — nic nie zapisano. Dodaj --write, żeby zapisać.',
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
