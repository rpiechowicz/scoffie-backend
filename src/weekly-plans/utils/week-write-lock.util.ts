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
 *
 * Oddaje rewizję tygodnia odczytaną pod zamkiem — z nią porównuje się
 * `expectedRevision` (ADR `plan-portions-safe-editing`).
 */
export async function lockWeekForWrite(
  tx: Prisma.TransactionClient,
  weeklyPlanId: string,
): Promise<number> {
  const { revision } = await tx.weeklyPlan.update({
    where: { id: weeklyPlanId },
    data: { updatedAt: new Date() },
    select: { revision: true },
  });
  return revision;
}

/**
 * Rewizja tygodnia +1 — raz na transakcję, która zmienia treść planu, po
 * `lockWeekForWrite`. Zwrócona wartość to stempel zmienionych w tej
 * transakcji pozycji i porcji (`PlanItem.revision`, `PlanItemPortion.revision`).
 */
export async function bumpWeekRevision(
  tx: Prisma.TransactionClient,
  weeklyPlanId: string,
): Promise<number> {
  const { revision } = await tx.weeklyPlan.update({
    where: { id: weeklyPlanId },
    data: { revision: { increment: 1 } },
    select: { revision: true },
  });
  return revision;
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

/**
 * Zmiana składu domu: rewizja +1 w każdym tygodniu od `monday` i nowy stempel
 * WSZYSTKICH pozycji i porcji tych tygodni — zgrubnie, bo zdarzenie jest
 * rzadkie, a przeliczenie porcji dotyka wielu pozycji naraz. Każdy token
 * z odczytu sprzed zmiany składu przestaje pasować (klient odświeża).
 * Po `lockWeeksForWriteFrom`, w tej samej transakcji.
 */
export async function bumpWeeksRevisionFrom(
  tx: Prisma.TransactionClient,
  householdId: string,
  monday: Date,
): Promise<void> {
  const scope = { householdId, weekStart: { gte: monday } };
  await tx.weeklyPlan.updateMany({
    where: scope,
    data: { revision: { increment: 1 } },
  });
  // Tygodnie są już zablokowane (`lockWeeksForWriteFrom`), więc odczyt po
  // podbiciu widzi dokładnie te rewizje, które stemplujemy.
  const weeks = await tx.weeklyPlan.findMany({
    where: scope,
    select: { id: true, revision: true },
  });
  for (const week of weeks) {
    await tx.planItem.updateMany({
      where: { weeklyPlanId: week.id },
      data: { revision: week.revision },
    });
    await tx.planItemPortion.updateMany({
      where: { planItem: { weeklyPlanId: week.id } },
      data: { revision: week.revision },
    });
  }
}
