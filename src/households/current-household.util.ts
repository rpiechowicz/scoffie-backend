import type { PrismaService } from '../prisma/prisma.service';

/**
 * Dom zalogowanej osoby po HTTP — ta sama reguła co przy logowaniu
 * (`auth.service`: `currentHouseholdId`) i w Cookidoo: NAJSTARSZE
 * członkostwo. Id zawsze z JWT, nigdy od klienta. Brak domu = `null`
 * (świeże konto przed onboardingiem), nie błąd.
 */
export async function currentHouseholdId(
  prisma: PrismaService,
  userId: string,
): Promise<string | null> {
  const membership = await prisma.membership.findFirst({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    select: { householdId: true },
  });
  return membership?.householdId ?? null;
}
