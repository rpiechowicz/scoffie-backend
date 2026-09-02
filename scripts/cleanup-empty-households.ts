/**
 * Sprząta gospodarstwa, w których nie został ani jeden domownik.
 *
 * Od teraz takie gospodarstwa nie powstają: `settleHouseholdAfterMemberLeft`
 * kasuje dom w tej samej transakcji, w której wychodzi z niego ostatnia osoba
 * (wyjście, usunięcie domownika, przeniesienie się przez zaproszenie, kasowanie
 * konta). Ten skrypt jest dla baz, które żyły PRZED tą zmianą: wcześniej
 * regułę stosowało wyłącznie kasowanie konta, więc każde zwykłe wyjście
 * z gospodarstwa zostawiało w bazie rekord, do którego nikt już nie miał
 * dostępu i którego nic nigdy nie sprzątało.
 *
 * Usunięcie gospodarstwa kaskaduje na plany tygodniowe, listy zakupów,
 * archiwa, przepisy i zaproszenia. Jest bezpieczne wyłącznie dlatego, że
 * warunkiem jest ZERO członkostw — nie ma komu tych danych stracić, bo nie ma
 * już nikogo, kto mógłby je otworzyć.
 *
 * Użycie:
 *   pnpm households:cleanup:empty              # dry-run, tylko raport
 *   pnpm households:cleanup:empty -- --write   # kasowanie
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const shouldWrite = process.argv.includes('--write');

  // Ten sam pas bezpieczeństwa, co w `settleHouseholdAfterMemberLeft`:
  // dom bez domowników, który trzyma katalog, NIE jest śmieciem — jego
  // skasowanie zabrałoby przepisy i plany wszystkich gospodarstw.
  const empty = await prisma.household.findMany({
    where: {
      memberships: { none: {} },
      recipes: { none: { isCatalog: true } },
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      name: true,
      createdAt: true,
      _count: {
        select: {
          weeklyPlans: true,
          shoppingLists: true,
          recipes: true,
          invitations: true,
        },
      },
    },
  });

  if (empty.length === 0) {
    console.log('Brak gospodarstw bez domowników — nie ma czego sprzątać.');
    return;
  }

  console.log(
    `Gospodarstwa bez domowników: ${empty.length}${shouldWrite ? '' : ' (dry-run)'}`,
  );
  for (const household of empty) {
    console.log(
      [
        `  ${household.id}`,
        `„${household.name}"`,
        `utworzone ${household.createdAt.toISOString().slice(0, 10)}`,
        `plany: ${household._count.weeklyPlans}`,
        `listy: ${household._count.shoppingLists}`,
        `przepisy: ${household._count.recipes}`,
        `zaproszenia: ${household._count.invitations}`,
      ].join(' | '),
    );
  }

  if (!shouldWrite) {
    console.log('\nNic nie skasowano. Uruchom z `-- --write`, żeby zapisać.');
    return;
  }

  const { count } = await prisma.household.deleteMany({
    where: {
      id: { in: empty.map((household) => household.id) },
      // Drugi raz, w tym samym zapytaniu: między listą a kasowaniem ktoś
      // mógł przenieść katalog.
      recipes: { none: { isCatalog: true } },
    },
  });
  console.log(`\nUsunięto gospodarstw: ${count}.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
