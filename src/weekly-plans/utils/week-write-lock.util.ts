import { Prisma } from '@prisma/client';

/**
 * Zamek zapisu tygodnia — KAŻDA transakcja zmieniająca pozycje planu bierze
 * go, zanim przeczyta albo ruszy `PlanItem`.
 *
 * To zwykły `UPDATE` wiersza `WeeklyPlan`, i właśnie dlatego działa w obu
 * poziomach izolacji, których tu używamy:
 *  - blokada wiersza szereguje piszących — drugi czeka, aż pierwszy zatwierdzi;
 *  - w READ COMMITTED (`upsertWeekSlot`, `removeWeekSlot`) kolejne zapytania
 *    po odczekaniu widzą już stan po zatwierdzeniu tamtego;
 *  - w SERIALIZABLE (`applyWeekPlan`, `clearWeekPlan`) migawka bywa starsza
 *    niż cudze zatwierdzenie — wtedy ten `UPDATE` kończy się błędem
 *    serializacji (P2034), `runSerializable` ponawia próbę ze świeżą migawką
 *    i WSZYSTKIE warunki w transakcji liczą się od nowa.
 *
 * Bez tego SSI Postgresa nie pomaga: konflikty wykrywa tylko między
 * transakcjami SERIALIZABLE, a ręczna edycja slotu idzie w READ COMMITTED.
 * Dołożenie NOWEGO wiersza przez domownika nie kolidowało wtedy z niczym
 * i kontrola „plan się nie zmienił" liczyła się na nieaktualnej migawce.
 *
 * Blokada w pamięci procesu nie wchodzi w grę — instancji bywa kilka.
 */
export async function lockWeekForWrite(
  tx: Prisma.TransactionClient,
  weeklyPlanId: string,
): Promise<void> {
  await tx.weeklyPlan.update({
    where: { id: weeklyPlanId },
    data: { updatedAt: new Date() },
    select: { id: true },
  });
}

/** Jak wyżej, dla wszystkich tygodni domu od `monday` (zmiana składu domu). */
export async function lockWeeksForWriteFrom(
  tx: Prisma.TransactionClient,
  householdId: string,
  monday: Date,
): Promise<void> {
  await tx.weeklyPlan.updateMany({
    where: { householdId, weekStart: { gte: monday } },
    data: { updatedAt: new Date() },
  });
}
