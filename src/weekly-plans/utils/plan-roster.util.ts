import { Prisma } from '@prisma/client';
import { autoPlannedServings } from './planned-servings.util';
import { currentWeekStart, formatWeekStart } from './week-formatting.util';

/// Klient Prismy albo transakcja — jak w `household-cleanup.util.ts`.
/// Porządkowanie planu MUSI iść w tej samej transakcji co usunięcie
/// członkostwa, które je wywołało; osobna transakcja zostawiałaby okno,
/// w którym dom ma już nowy skład, a plan jeszcze stary.
export type PrismaLike = Prisma.TransactionClient;

export type PlanRosterOutcome = {
  /// Klucze tygodni (`YYYY-MM-DD`), których plan i lista mogły się zmienić —
  /// gotowe do rozgłoszenia przez gateway.
  touchedWeekStarts: string[];
  /// Itemy skasowane, bo odchodzący był ich JEDYNYM uczestnikiem.
  deletedItemIds: string[];
  /// Ile „Wspólnych" przeliczyło auto-porcje.
  reDerivedItemCount: number;
};

export type RosterChangeOutcome = {
  touchedWeekStarts: string[];
  reDerivedItemCount: number;
};

/// Tygodnie od bieżącego poniedziałku, które w ogóle mają plan. Wystarczy
/// jako lista „co przeładować" — gateway i tak rozgłasza zmianę per tydzień,
/// a klient sam odczyta, co się zmieniło.
async function listWeekStartsFrom(
  tx: PrismaLike,
  householdId: string,
  monday: Date,
): Promise<string[]> {
  const weeks = await tx.weeklyPlan.findMany({
    where: { householdId, weekStart: { gte: monday } },
    select: { weekStart: true },
    orderBy: { weekStart: 'asc' },
  });
  return weeks.map((week) => formatWeekStart(week.weekStart));
}

/// Listy zakupów tygodni od bieżącego poniedziałku do przeliczenia.
///
/// `updateMany`, a nie `ShoppingListService.markShoppingListStale`: tamto jest
/// metodą instancji (DI, a `HouseholdsModule` nie widzi `WeeklyPlansModule`),
/// a jej `upsert` ZAKŁADAŁBY wiersze list dla tygodni, które nigdy żadnej nie
/// miały. Brak wiersza i tak znaczy „zbuduj od zera" przy odczycie, więc
/// unieważnienie dotyczy wyłącznie tego, co realnie leży w cache'u.
async function markFutureShoppingListsStale(
  tx: PrismaLike,
  householdId: string,
  monday: Date,
): Promise<void> {
  await tx.shoppingList.updateMany({
    where: { householdId, weekStart: { gte: monday } },
    data: { isStale: true },
  });
}

/// Przelicza auto-porcje „Wspólnych" po zmianie składu gospodarstwa.
///
/// Rozpoznanie „to była wartość auto" jest tym samym porównaniem, którego
/// używa `WeeklyPlansService.resolveUpdatedPlannedServings`: zapisana liczba
/// równa STAREJ regule auto znaczy „nikt tego nie nadpisywał", więc przelicza
/// się na nową. Różna znaczy „wybór użytkownika" i zostaje.
///
/// Granica jest znana i akceptowana: ręcznie ustawione „gotuję 2 porcje"
/// w domu dwuosobowym jest nieodróżnialne od auto i przeliczy się razem z nim.
/// Docelowo rozstrzygnie to kolumna `servingsMode AUTO|MANUAL` — dopóki jej
/// nie ma, wybieramy cichy błąd w rzadkim przypadku zamiast pewnego,
/// systematycznego błędu w każdym (porcje dla dwojga po odejściu partnera).
async function reDeriveSharedServings(
  tx: PrismaLike,
  householdId: string,
  oldMemberCount: number,
  newMemberCount: number,
  monday: Date,
): Promise<number> {
  const previousAuto = autoPlannedServings(0, oldMemberCount);
  const nextAuto = autoPlannedServings(0, newMemberCount);
  // Także dla 13 -> 14: obie wartości przycinają się do 12, nie ma czego ruszać.
  if (previousAuto === nextAuto) {
    return 0;
  }

  const updated = await tx.planItem.updateMany({
    where: {
      plannedServings: previousAuto,
      // Pusty zbiór uczestników = „Wspólne". Itemy imienne liczą porcje
      // z długości listy, nie z liczby domowników, więc zmiana składu ich nie
      // dotyczy.
      participants: { none: {} },
      weeklyPlan: { householdId, weekStart: { gte: monday } },
    },
    data: { plannedServings: nextAuto },
  });

  return updated.count;
}

/// Zmiana składu gospodarstwa BEZ odejścia konkretnej osoby (ktoś dołączył).
/// Wołane z `HouseholdsService.acceptInvitation` z licznikami sprzed i po
/// `upsert` członkostwa, bo `upsert` nie mówi, czy coś stworzył.
export async function onRosterChanged(
  tx: PrismaLike,
  householdId: string,
  oldMemberCount: number,
  newMemberCount: number,
  now: Date = new Date(),
): Promise<RosterChangeOutcome> {
  if (oldMemberCount === newMemberCount) {
    return { touchedWeekStarts: [], reDerivedItemCount: 0 };
  }
  const monday = currentWeekStart(now);
  const reDerivedItemCount = await reDeriveSharedServings(
    tx,
    householdId,
    oldMemberCount,
    newMemberCount,
    monday,
  );
  if (reDerivedItemCount === 0) {
    return { touchedWeekStarts: [], reDerivedItemCount };
  }
  await markFutureShoppingListsStale(tx, householdId, monday);
  return {
    touchedWeekStarts: await listWeekStartsFrom(tx, householdId, monday),
    reDerivedItemCount,
  };
}

/// Sprząta plan po domowniku, który przestał należeć do gospodarstwa.
///
/// Wołane PO usunięciu członkostwa i PO `settleHouseholdAfterMemberLeft`,
/// w tej samej transakcji. Dotyczy wyłącznie tygodni od bieżącego
/// poniedziałku — przeszłość jest zapisem tego, co się wydarzyło (kto co
/// zjadł), i zostaje nietknięta.
///
/// Item, którego JEDYNYM uczestnikiem był odchodzący, jest kasowany, a nie
/// cicho awansowany na „Wspólny": wiersz istnieje dlatego, że TA osoba to je.
/// Po awansie danie pojawiłoby się na pulpicie każdego domownika i w jego
/// kaloriach, choć nikt go nie wybrał. Kasowanie nie zabiera nikomu nic
/// z ekranu — taki item jest dla pozostałych i tak niewidoczny, a mimo to
/// lista zakupów kupowała na niego jedzenie. Item współdzielony z kimś, kto
/// został, traci tylko wiersz odchodzącego.
export async function onMemberLeft(
  tx: PrismaLike,
  householdId: string,
  userId: string,
  now: Date = new Date(),
): Promise<PlanRosterOutcome> {
  const monday = currentWeekStart(now);
  const weekScope = { householdId, weekStart: { gte: monday } };

  const touchedWeekStarts = await listWeekStartsFrom(tx, householdId, monday);

  // Kandydatów do skasowania trzeba znaleźć PRZED usunięciem wierszy
  // uczestników — potem nie ma już po czym poznać, czy zbiór był jednoosobowy.
  const affected = await tx.planItem.findMany({
    where: {
      weeklyPlan: weekScope,
      participants: { some: { userId } },
    },
    select: {
      id: true,
      plannedServings: true,
      participants: { select: { userId: true } },
    },
  });
  const deletedItemIds = affected
    .filter((item) => item.participants.length === 1)
    .map((item) => item.id);
  // Item imienny dzielony z kimś, kto został: porcje liczone z długości
  // listy uczestników (nie z liczby domowników) też muszą zmaleć — inaczej
  // lista kupuje dla dwóch, a bilans dubluje kalorie. Ręcznie ustawioną
  // liczbę porcji (inną niż auto) zostawiamy.
  for (const item of affected) {
    if (item.participants.length < 2) continue;
    if (item.plannedServings !== item.participants.length) continue;
    await tx.planItem.update({
      where: { id: item.id },
      data: { plannedServings: item.participants.length - 1 },
    });
  }

  if (deletedItemIds.length > 0) {
    // Kaskada z `PlanItem` zabiera uczestników i „zjedzone", więc osobne
    // deleteMany na nich nie są tu potrzebne.
    await tx.planItem.deleteMany({ where: { id: { in: deletedItemIds } } });
  }

  await tx.planItemParticipant.deleteMany({
    where: { userId, planItem: { weeklyPlan: weekScope } },
  });
  await tx.planItemConsumption.deleteMany({
    where: { userId, planItem: { weeklyPlan: weekScope } },
  });

  // Skład zmienił się na pewno, więc auto-porcje „Wspólnych" liczą się od
  // nowa. Każda ze ścieżek (wyjście, usunięcie, przeprowadzka, kasowanie
  // konta) zdejmuje dokładnie jedno członkostwo na wywołanie, więc stary
  // licznik to nowy + 1.
  const newMemberCount = await tx.membership.count({ where: { householdId } });
  const reDerivedItemCount = await reDeriveSharedServings(
    tx,
    householdId,
    newMemberCount + 1,
    newMemberCount,
    monday,
  );

  await markFutureShoppingListsStale(tx, householdId, monday);

  return { touchedWeekStarts, deletedItemIds, reDerivedItemCount };
}
