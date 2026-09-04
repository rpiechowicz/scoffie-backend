import type { PrismaClient } from '@prisma/client';

/**
 * Paczka danych osoby — RODO art. 15 (dostęp) i art. 20 (przenoszenie).
 *
 * Czysta funkcja na kliencie Prismy, a nie metoda serwisu Nest, bo z tego
 * samego kodu korzystają DWA wejścia: `GET /me/export` (osoba sama, z
 * telefonu) i `pnpm rodo:export` (wniosek mailowy, obsługiwany z konsoli).
 * Gdyby każde wejście składało paczkę po swojemu, po pół roku różniłyby się
 * i któraś z nich nie oddawałaby wszystkiego.
 *
 * Co CELOWO nie wchodzi:
 * - sekrety i tokeny (refresh tokeny, tokeny push, zaszyfrowane dane logowania
 *   Cookidoo) — to nie dane „o osobie", tylko klucze do konta;
 * - dane innych domowników (ich preferencje, sylwetka, rozmowy) — art. 15
 *   ust. 4: prawo dostępu nie może naruszać praw innych osób. Z gospodarstwa
 *   wraca tylko nazwa i rola tej osoby;
 * - księga kosztów asystenta (`AiUsage`) — liczona per gospodarstwo, nie
 *   per osoba, i nie zawiera treści.
 */
export const USER_EXPORT_FORMAT = 'scoffie-user-export/1';

export type UserExport = NonNullable<
  Awaited<ReturnType<typeof buildUserExport>>
>;

export async function buildUserExport(prisma: PrismaClient, userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      displayName: true,
      email: true,
      emailVerified: true,
      authProvider: true,
      avatarUrl: true,
      yearOfBirth: true,
      heightCm: true,
      weightKg: true,
      sex: true,
      onboardingCompletedAt: true,
      lastLoginAt: true,
      createdAt: true,
      updatedAt: true,
      preferences: true,
      // Do wyszukania subskrypcji; NIE trafia do eksportu (patrz niżej).
      identityHash: true,
    },
  });
  if (!user) return null;

  const [
    consents,
    memberships,
    invitationsSent,
    invitationsReceived,
    recipes,
    participations,
    consumptions,
    dailySteps,
    conversations,
    reports,
    devices,
    cookidoo,
    aiUsage,
    memoryNotes,
    subscriptions,
  ] = await Promise.all([
    prisma.consentEvent.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: {
        kind: true,
        action: true,
        documentVersion: true,
        source: true,
        appVersion: true,
        householdId: true,
        createdAt: true,
      },
    }),
    prisma.membership.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: {
        role: true,
        createdAt: true,
        household: { select: { id: true, name: true, createdAt: true } },
      },
    }),
    prisma.invitation.findMany({
      where: { createdById: userId },
      orderBy: { createdAt: 'asc' },
      select: {
        householdId: true,
        createdAt: true,
        expiresAt: true,
        redeemedAt: true,
      },
    }),
    prisma.invitation.findMany({
      where: { OR: [{ redeemedById: userId }, { invitedUserId: userId }] },
      orderBy: { createdAt: 'asc' },
      select: {
        householdId: true,
        createdAt: true,
        redeemedAt: true,
        declinedAt: true,
      },
    }),
    prisma.recipe.findMany({
      where: { authorId: userId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        householdId: true,
        title: true,
        description: true,
        mealType: true,
        suitableMealTypes: true,
        servings: true,
        prepTimeMinutes: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        ingredients: {
          select: { name: true, amount: true, unit: true },
        },
      },
    }),
    prisma.planItemParticipant.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: {
        createdAt: true,
        planItem: {
          select: {
            dayOfWeek: true,
            mealType: true,
            plannedServings: true,
            weeklyPlan: { select: { householdId: true, weekStart: true } },
            recipe: { select: { id: true, title: true } },
          },
        },
      },
    }),
    prisma.planItemConsumption.findMany({
      where: { userId },
      orderBy: { eatenAt: 'asc' },
      select: {
        eatenAt: true,
        planItem: {
          select: {
            dayOfWeek: true,
            mealType: true,
            weeklyPlan: { select: { householdId: true, weekStart: true } },
            recipe: { select: { id: true, title: true } },
          },
        },
      },
    }),
    prisma.dailyStepCount.findMany({
      where: { userId },
      orderBy: { date: 'asc' },
      select: { date: true, steps: true, stepsGoal: true, source: true },
    }),
    prisma.agentConversation.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        householdId: true,
        status: true,
        title: true,
        createdAt: true,
        lastMessageAt: true,
        messages: {
          orderBy: { createdAt: 'asc' },
          select: {
            role: true,
            kind: true,
            text: true,
            card: true,
            createdAt: true,
            hiddenAt: true,
          },
        },
      },
    }),
    prisma.agentReport.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: {
        reason: true,
        comment: true,
        messageText: true,
        createdAt: true,
      },
    }),
    prisma.pushDevice.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: {
        platform: true,
        appBundleId: true,
        apnsEnvironment: true,
        isActive: true,
        createdAt: true,
        lastSeenAt: true,
      },
    }),
    prisma.cookidooIntegration.findMany({
      where: { connectedById: userId },
      select: {
        householdId: true,
        status: true,
        lastVerifiedAt: true,
        createdAt: true,
      },
    }),
    prisma.aiUsage.aggregate({
      where: { userId },
      _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true, costMicroUsd: true },
      _min: { createdAt: true },
      _max: { createdAt: true },
    }),
    prisma.agentMemory.findMany({
      where: { createdByUserId: userId },
      orderBy: { createdAt: 'asc' },
      select: { householdId: true, text: true, kind: true, createdAt: true },
    }),
    // Subskrypcje wiszą na HASZU tożsamości, nie na `userId` — bo mają
    // przeżywać skasowanie konta. Do eksportu (art. 15) wchodzą wyłącznie
    // wiersze tej osoby i BEZ hasza: hasz jest naszym kluczem wewnętrznym,
    // a jego wydanie ułatwiałoby dopasowanie danych po usunięciu konta.
    user.identityHash
      ? prisma.subscription.findMany({
          where: { identityHash: user.identityHash },
          orderBy: { createdAt: 'desc' },
          select: {
            provider: true,
            productId: true,
            status: true,
            expiresAt: true,
            graceExpiresAt: true,
            environment: true,
            createdAt: true,
            updatedAt: true,
          },
        })
      : Promise.resolve([]),
  ]);

  // `identityHash` NIE wychodzi w eksporcie: to nasz klucz wewnętrzny, a jego
  // wydanie ułatwiałoby powiązanie danych z kontem, którego już nie ma.
  const { preferences, identityHash: _identityHash, ...profile } = user;
  let preferencesOut: Omit<NonNullable<typeof preferences>, 'userId'> | null =
    null;
  if (preferences) {
    const { userId: _ownerId, ...rest } = preferences;
    preferencesOut = rest;
  }

  return {
    format: USER_EXPORT_FORMAT,
    exportedAt: new Date(),
    profile,
    preferences: preferencesOut,
    consents,
    households: memberships.map((m) => ({
      id: m.household.id,
      name: m.household.name,
      role: m.role,
      joinedAt: m.createdAt,
      householdCreatedAt: m.household.createdAt,
    })),
    invitations: { sent: invitationsSent, received: invitationsReceived },
    subscriptions,
    recipes,
    meals: {
      planned: participations.map((p) => ({
        householdId: p.planItem.weeklyPlan.householdId,
        weekStart: p.planItem.weeklyPlan.weekStart,
        dayOfWeek: p.planItem.dayOfWeek,
        mealType: p.planItem.mealType,
        plannedServings: p.planItem.plannedServings,
        recipe: p.planItem.recipe,
        addedAt: p.createdAt,
      })),
      eaten: consumptions.map((c) => ({
        householdId: c.planItem.weeklyPlan.householdId,
        weekStart: c.planItem.weeklyPlan.weekStart,
        dayOfWeek: c.planItem.dayOfWeek,
        mealType: c.planItem.mealType,
        recipe: c.planItem.recipe,
        eatenAt: c.eatenAt,
      })),
    },
    dailySteps,
    assistant: {
      conversations: conversations.map((conversation) => ({
        ...conversation,
        messages: conversation.messages.map((message) => ({
          ...message,
          card: redactOthersFromCard(message.card, userId),
        })),
      })),
      reports,
      // Polityka §2: „dane o użyciu" są danymi osobowymi — sumy, nie wiersze
      // (pojedynczy wiersz nie mówi o osobie nic ponad to).
      usage: {
        turns: aiUsage._count._all,
        inputTokens: aiUsage._sum.inputTokens ?? 0,
        outputTokens: aiUsage._sum.outputTokens ?? 0,
        costMicroUsd: aiUsage._sum.costMicroUsd ?? 0,
        firstAt: aiUsage._min.createdAt,
        lastAt: aiUsage._max.createdAt,
      },
      memoryNotes,
    },
    devices,
    cookidoo,
  };
}

/**
 * Art. 15 ust. 4: paczka jednej osoby nie oddaje danych innych. Karta
 * porcji (HOUSEHOLD_SPLIT) niesie cel kaloryczny, dietę i alergeny KAŻDEGO
 * domownika — zostaje tylko wiersz właściciela paczki.
 */
function redactOthersFromCard(card: unknown, userId: string): unknown {
  if (!card || typeof card !== 'object') return card;
  const record = card as Record<string, unknown>;
  if (!Array.isArray(record.portions)) return card;
  return {
    ...record,
    portions: record.portions.filter(
      (portion) =>
        portion &&
        typeof portion === 'object' &&
        (portion as { userId?: unknown }).userId === userId,
    ),
    portionsRedacted: true,
  };
}
