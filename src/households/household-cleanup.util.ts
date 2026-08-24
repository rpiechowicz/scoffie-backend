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
  | { outcome: 'UNCHANGED' };

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
