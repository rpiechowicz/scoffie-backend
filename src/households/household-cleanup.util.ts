import { Prisma } from '@prisma/client';

/**
 * Klient Prismy albo transakcja — obie ścieżki wołają te same operacje, a
 * porządkowanie gospodarstwa zawsze ma iść w tej samej transakcji co usunięcie
 * członkostwa, które je wywołało.
 */
export type PrismaLike = Prisma.TransactionClient;

export type HouseholdSettlement =
  | { outcome: 'DELETED' }
  | { outcome: 'OWNER_PROMOTED'; promotedUserId: string }
  | { outcome: 'UNCHANGED' }
  /**
   * Zero członków, ale dom trzyma wspólny katalog — zostaje. Skasowanie go
   * zabrałoby kaskadą wszystkie przepisy katalogowe razem z pozycjami
   * planów KAŻDEGO gospodarstwa, które z nich korzysta.
   */
  | { outcome: 'KEPT_CATALOG' };

/**
 * Doprowadza gospodarstwo do porządku po tym, jak ktoś z niego wyszedł.
 *
 * Dwie reguły, obie wynikające z tego, że gospodarstwo bez ludzi albo bez
 * właściciela jest bezużyteczne, a mimo to zajmuje miejsce i wchodzi w drogę:
 *
 * 1. **Zero członków → gospodarstwo znika.** Razem z nim kaskadą lecą plany,
 *    listy zakupów i przepisy, do których i tak nikt już nie ma dostępu.
 *    Bez tego kroku każde przejście do innego gospodarstwa zostawiało w bazie
 *    pusty rekord, którego nikt nigdy nie odwiedzi ani nie skasuje.
 * 2. **Zostali członkowie, ale żaden nie jest właścicielem → awansuje
 *    najstarszy stażem.** Inaczej reszta domowników zostaje z gospodarstwem,
 *    którego nikt nie może administrować: ani zaprosić kogoś, ani zmienić
 *    nazwy, ani usunąć członka.
 *
 * Reguła istniała już wcześniej, ale wyłącznie wewnątrz `UsersService.
 * deleteAccount` — czyli działała tylko przy kasowaniu konta, a nie przy
 * zwykłym wyjściu z gospodarstwa. Tutaj jest raz, dla wszystkich ścieżek.
 */
/**
 * Poświadczenia Cookidoo należą do osoby, która je podała: gdy ta osoba
 * opuszcza dom (sama, usunięta, albo z kontem), jej hasło nie może zostać
 * w domu do dyspozycji pozostałych. Dom łączy się na nowo własnym hasłem.
 */
export async function revokeCookidooCredentialsOf(
  tx: PrismaLike,
  householdId: string,
  userId: string,
): Promise<number> {
  const result = await tx.cookidooIntegration.deleteMany({
    where: { householdId, connectedById: userId },
  });
  return result.count;
}

export async function settleHouseholdAfterMemberLeft(
  tx: PrismaLike,
  householdId: string,
): Promise<HouseholdSettlement> {
  const remaining = await tx.membership.findMany({
    where: { householdId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, userId: true, role: true },
  });

  if (remaining.length === 0) {
    // Pas bezpieczeństwa, nie zwykła ścieżka: bot importu jest OWNER-em domu
    // katalogu i nie powinien z niego wychodzić. Ale gdyby ktoś skasował to
    // konto (albo katalog leżał w zwykłym domu, jak na produkcji do 31.08),
    // ta jedna gałąź dzieli „sprzątanie pustego domu" od „utraty katalogu
    // dla wszystkich".
    const catalogRecipes = await tx.recipe.count({
      where: { householdId, isCatalog: true },
    });
    if (catalogRecipes > 0) {
      return { outcome: 'KEPT_CATALOG' };
    }
    await tx.household.delete({ where: { id: householdId } });
    return { outcome: 'DELETED' };
  }

  if (remaining.some((membership) => membership.role === 'OWNER')) {
    return { outcome: 'UNCHANGED' };
  }

  const heir = remaining[0];
  await tx.membership.update({
    where: { id: heir.id },
    data: { role: 'OWNER' },
  });
  return { outcome: 'OWNER_PROMOTED', promotedUserId: heir.userId };
}
