import { MembershipRole, Prisma } from '@prisma/client';
import { effectiveAvatarColor } from '../../common/avatar-color.util';
import { readAgentEnv } from '../../config/agent-env';
import { isAppleRelay } from '../../mail/mail-eligibility';
import { decideHouseholdPlan } from '../common/plan-decision';
import type { HouseholdPlan, UserListItem } from '../contract';
import {
  IDENTITY_SELECT,
  LIVE_SUBSCRIPTION_SELECT,
  identityHashOf,
  indexByIdentity,
  payingUserIds,
  type IdentityFields,
  type LiveSubscription,
} from './admin-plans';

/**
 * Wiersze osób (`UserListItem`) i składy domów składane w paczce: jedno
 * zapytanie o członkostwa, jedno o składy, jedno o subskrypcje, plan
 * z pamięci. Z tych samych klocków korzysta lista, wyszukiwarka i karta
 * osoby — trzy ekrany mają pokazywać tę samą osobę tak samo.
 */

export const USER_ROW_SELECT = {
  id: true,
  displayName: true,
  email: true,
  avatarColor: true,
  onboardingCompletedAt: true,
  lastLoginAt: true,
  lastSeenAt: true,
  createdAt: true,
} as const satisfies Prisma.UserSelect;

export type UserRow = {
  id: string;
  displayName: string;
  email: string | null;
  avatarColor: number | null;
  onboardingCompletedAt: Date | null;
  lastLoginAt: Date | null;
  lastSeenAt: Date | null;
  createdAt: Date;
};

export type Home = { householdId: string; role: MembershipRole };

/** Domownik: pola do listy składu i do hasza tożsamości zakupowej. */
export type RosterMember = {
  userId: string;
  role: MembershipRole;
  displayName: string;
  avatarColor: number;
  lastLoginAt: Date | null;
  lastSeenAt: Date | null;
  identity: IdentityFields;
};

export type HouseholdRoster = {
  id: string;
  name: string;
  tierOverride: string | null;
  createdAt: Date;
  members: RosterMember[];
};

export type HouseholdInfo = HouseholdRoster & { plan: HouseholdPlan };

/**
 * „Które gospodarstwo" osoby: NAJSTARSZE członkostwo — ta sama reguła, co
 * `AuthService.buildAuthResult` (tym domem żyje telefon).
 */
export async function loadHomes(
  tx: Prisma.TransactionClient,
  userIds: readonly string[],
): Promise<Map<string, Home>> {
  const homes = new Map<string, Home>();
  if (userIds.length === 0) return homes;
  const memberships = await tx.membership.findMany({
    where: { userId: { in: [...userIds] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { userId: true, householdId: true, role: true },
  });
  for (const membership of memberships) {
    if (!homes.has(membership.userId)) {
      homes.set(membership.userId, {
        householdId: membership.householdId,
        role: membership.role,
      });
    }
  }
  return homes;
}

/** Domy z pełnym składem, domownicy od najstarszego członkostwa. */
export async function loadHouseholdRosters(
  tx: Prisma.TransactionClient,
  householdIds: readonly string[],
): Promise<HouseholdRoster[]> {
  const unique = [...new Set(householdIds)];
  if (unique.length === 0) return [];
  const rows = await tx.household.findMany({
    where: { id: { in: unique } },
    select: {
      id: true,
      name: true,
      tierOverride: true,
      createdAt: true,
      memberships: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          userId: true,
          role: true,
          user: {
            select: {
              displayName: true,
              avatarColor: true,
              lastLoginAt: true,
              lastSeenAt: true,
              ...IDENTITY_SELECT,
            },
          },
        },
      },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    tierOverride: row.tierOverride,
    createdAt: row.createdAt,
    members: row.memberships.map((membership) => ({
      userId: membership.userId,
      role: membership.role,
      displayName: membership.user.displayName,
      avatarColor: effectiveAvatarColor({
        id: membership.userId,
        avatarColor: membership.user.avatarColor,
      }),
      lastLoginAt: membership.user.lastLoginAt,
      lastSeenAt: membership.user.lastSeenAt,
      identity: {
        identityHash: membership.user.identityHash,
        appleSub: membership.user.appleSub,
        googleId: membership.user.googleId,
        authProvider: membership.user.authProvider,
      },
    })),
  }));
}

/**
 * Subskrypcje ACTIVE / GRACE potrzebne DLA TYCH domów i osób: po haszach
 * domowników (plan) i po kupującym (czy płaci). Lista wszystkich osób bierze
 * zamiast tego `loadLiveSubscriptions` — i tak potrzebuje kompletu do filtra
 * „płaci" i do statystyk.
 */
export async function loadLiveSubscriptionsFor(
  tx: Prisma.TransactionClient,
  rosters: readonly HouseholdRoster[],
  userIds: readonly string[],
): Promise<LiveSubscription[]> {
  const hashes = new Set<string>();
  for (const roster of rosters) {
    for (const member of roster.members) {
      const hash = identityHashOf(member.identity);
      if (hash) hashes.add(hash);
    }
  }
  if (hashes.size === 0 && userIds.length === 0) return [];
  return tx.subscription.findMany({
    where: {
      status: { in: ['ACTIVE', 'GRACE'] },
      OR: [
        { identityHash: { in: [...hashes] } },
        { purchaserUserId: { in: [...userIds] } },
      ],
    },
    select: LIVE_SUBSCRIPTION_SELECT,
  });
}

/** Plan każdego domu z już wczytanych subskrypcji. */
export function withPlans(
  rosters: readonly HouseholdRoster[],
  subscriptions: readonly LiveSubscription[],
  now: Date,
): Map<string, HouseholdInfo> {
  const byIdentity = indexByIdentity(subscriptions);
  const envTierOverride = readAgentEnv().tierOverride;
  return new Map(
    rosters.map((roster) => [
      roster.id,
      {
        ...roster,
        plan: decideHouseholdPlan(
          {
            tierOverride: roster.tierOverride,
            memberHashes: roster.members.map((member) =>
              identityHashOf(member.identity),
            ),
          },
          byIdentity,
          now,
          envTierOverride,
        ).plan,
      },
    ]),
  );
}

export function toUserListItem(
  user: UserRow,
  home: Home | undefined,
  household: HouseholdInfo | undefined,
  paying: boolean,
): UserListItem {
  return {
    id: user.id,
    displayName: user.displayName,
    email: user.email,
    hiddenEmail: user.email ? isAppleRelay(user.email) : false,
    onboardingCompletedAt: user.onboardingCompletedAt?.toISOString() ?? null,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    householdId: household?.id ?? null,
    householdName: household?.name ?? null,
    role: household && home ? home.role : null,
    plan: household?.plan ?? null,
    paying,
    // Kolor, którym osoba NAPRAWDĘ świeci w aplikacji — konta sprzed
    // przydziału kolorów liczą go z hasza id, tak jak iOS.
    avatarColor: effectiveAvatarColor(user),
  };
}

export type UserItemsResult = {
  items: UserListItem[];
  homes: Map<string, Home>;
  households: Map<string, HouseholdInfo>;
};

/**
 * Wiersze listy dla podanych osób, w ich kolejności. `allLiveSubscriptions`
 * podaje lista (ma komplet); karta osoby i wyszukiwarka dociągają tylko to,
 * czego potrzebują.
 */
export async function buildUserListItems(
  tx: Prisma.TransactionClient,
  users: readonly UserRow[],
  now: Date,
  allLiveSubscriptions?: readonly LiveSubscription[],
): Promise<UserItemsResult> {
  const userIds = users.map((user) => user.id);
  const homes = await loadHomes(tx, userIds);
  const rosters = await loadHouseholdRosters(
    tx,
    [...homes.values()].map((home) => home.householdId),
  );
  const subscriptions =
    allLiveSubscriptions ??
    (await loadLiveSubscriptionsFor(tx, rosters, userIds));
  const households = withPlans(rosters, subscriptions, now);
  const paying = payingUserIds(subscriptions, now);
  const items = users.map((user) => {
    const home = homes.get(user.id);
    return toUserListItem(
      user,
      home,
      home ? households.get(home.householdId) : undefined,
      paying.has(user.id),
    );
  });
  return { items, homes, households };
}
