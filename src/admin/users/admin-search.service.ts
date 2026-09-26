import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  catalogHouseholdId,
  catalogOwnerUserId,
} from '../../common/catalog-owner';
import { PrismaService } from '../../prisma/prisma.service';
import type { HouseholdListItem, Pool, SearchResults } from '../contract';
import { readOnlyQuery } from '../read-only-query';
import { payingUserIds } from './admin-plans';
import {
  normalizeQuery,
  sqlFoldedContains,
  sqlIdContains,
} from './admin-text-search';
import {
  loadHomes,
  loadHouseholdRosters,
  loadLiveSubscriptionsFor,
  toUserListItem,
  withPlans,
  type HouseholdInfo,
  type UserRow,
} from './admin-user-items';
import { inPlansByRecipe } from '../common/recipe-in-plans';
import {
  toRecipeListItem,
  type RecipeListRow,
} from '../catalog/recipe-list-item';

/** Ile trafień na grupę — tyle mieści podpowiedź ⌘K bez przewijania. */
export const SEARCH_LIMIT = 6;

/**
 * Pula w wyszukiwarce jest NEUTRALNA. Podpowiedź ⌘K jej nie pokazuje
 * (nazwa domu, liczba osób, plan), a wyszukiwarka idzie przy każdym
 * wciśnięciu klawisza — liczenie puli (plan, okres, liczniki, a na próbie
 * jeszcze wybór osoby, bo pula próbna jest osobista) byłoby kosztem bez
 * odbiorcy. Prawdziwa pula jest na karcie domu.
 */
const SEARCH_POOL: Pool = {
  scopeId: '',
  messages: { used: 0, limit: 0 },
  plans: { used: 0, limit: 0 },
  resetsAt: null,
};

type RecipeRow = RecipeListRow & {
  favorites: number;
  inPlans: number;
};

/**
 * `GET /admin/search?q=` — osoby (imię, e-mail, id), domy (nazwa, id)
 * i przepisy katalogu (tytuł, id); bez polskich znaków też trafia.
 */
@Injectable()
export class AdminSearchService {
  constructor(private readonly prisma: PrismaService) {}

  search(raw: string | undefined): Promise<SearchResults> {
    const q = normalizeQuery(raw);
    if (!q) {
      return Promise.resolve({ users: [], households: [], recipes: [] });
    }
    const now = new Date();
    return readOnlyQuery(this.prisma, async (tx) => {
      const users = await tx.$queryRaw<UserRow[]>`
        SELECT u."id", u."displayName", u."email", u."avatarColor",
               u."onboardingCompletedAt", u."lastLoginAt", u."lastSeenAt", u."createdAt"
        FROM "User" u
        WHERE u."id" <> ${catalogOwnerUserId()}::uuid
          AND (${sqlFoldedContains(Prisma.sql`u."displayName"`, q)}
            OR ${sqlFoldedContains(Prisma.sql`COALESCE(u."email", '')`, q)}
            OR ${sqlIdContains(Prisma.sql`u."id"`, q)})
        ORDER BY u."lastSeenAt" DESC NULLS LAST, u."createdAt" DESC, u."id" ASC
        LIMIT ${SEARCH_LIMIT}::int`;

      const householdIds = await tx.$queryRaw<{ id: string }[]>`
        SELECT h."id"
        FROM "Household" h
        WHERE h."id" <> ${catalogHouseholdId()}::uuid
          AND (${sqlFoldedContains(Prisma.sql`h."name"`, q)}
            OR ${sqlIdContains(Prisma.sql`h."id"`, q)})
        ORDER BY h."name" ASC, h."id" ASC
        LIMIT ${SEARCH_LIMIT}::int`;

      const recipes = await this.recipes(tx, q, now);

      // Składy domów osób i znalezionych domów — jednym zapytaniem, plan
      // z jednego odczytu subskrypcji.
      const userIds = users.map((user) => user.id);
      const homes = await loadHomes(tx, userIds);
      const rosters = await loadHouseholdRosters(tx, [
        ...[...homes.values()].map((home) => home.householdId),
        ...householdIds.map((row) => row.id),
      ]);
      const subscriptions = await loadLiveSubscriptionsFor(
        tx,
        rosters,
        userIds,
      );
      const households = withPlans(rosters, subscriptions, now);
      const paying = payingUserIds(subscriptions, now);
      const cookidoo = await this.cookidoo(
        tx,
        householdIds.map((row) => row.id),
      );

      return {
        users: users.map((user) => {
          const home = homes.get(user.id);
          return toUserListItem(
            user,
            home,
            home ? households.get(home.householdId) : undefined,
            paying.has(user.id),
          );
        }),
        households: householdIds
          .map((row) => households.get(row.id))
          .filter((household): household is HouseholdInfo => !!household)
          .map((household) =>
            toHouseholdListItem(household, cookidoo.get(household.id)),
          ),
        recipes: recipes.map((row) =>
          toRecipeListItem(row, row.inPlans, row.favorites),
        ),
      };
    });
  }

  /**
   * Przepisy WSPÓLNEGO katalogu (przepisy prywatne domów to dane domu —
   * panel pokazuje z nich tylko liczby, ROADMAPA §5.7), także wycofane:
   * admin szuka ich właśnie po to, żeby je przywrócić.
   *
   * `inPlans` — wspólna definicja z katalogiem (`inPlansByRecipe`).
   */
  private async recipes(
    tx: Prisma.TransactionClient,
    q: string,
    now: Date,
  ): Promise<RecipeRow[]> {
    const rows = await tx.$queryRaw<Omit<RecipeRow, 'inPlans'>[]>`
      SELECT r."id", r."title", r."imageUrl", r."isActive",
             r."mealType"::text AS "mealType",
             r."suitableMealTypes"::text[] AS "suitableMealTypes",
             r."difficulty"::text AS "difficulty", r."prepTimeMinutes",
             r."servings", r."nutritionKcal", r."nutritionProtein",
             r."nutritionFat", r."nutritionCarbs", r."allergens",
             r."updatedAt",
             (SELECT COUNT(*) FROM "RecipeFavorite" f
               WHERE f."recipeId" = r."id")::int AS "favorites"
      FROM "Recipe" r
      WHERE r."isCatalog" = true
        AND (${sqlFoldedContains(Prisma.sql`r."title"`, q)}
          OR ${sqlIdContains(Prisma.sql`r."id"`, q)})
      ORDER BY r."isActive" DESC, r."title" ASC, r."id" ASC
      LIMIT ${SEARCH_LIMIT}::int`;
    const inPlans = await inPlansByRecipe(
      tx,
      now,
      rows.map((row) => row.id),
    );
    return rows.map((row) => ({ ...row, inPlans: inPlans.get(row.id) ?? 0 }));
  }

  private async cookidoo(
    tx: Prisma.TransactionClient,
    householdIds: string[],
  ): Promise<Map<string, HouseholdListItem['cookidoo']>> {
    if (householdIds.length === 0) return new Map();
    const rows = await tx.cookidooIntegration.findMany({
      where: { householdId: { in: householdIds } },
      select: { householdId: true, status: true },
    });
    return new Map(
      rows.map((row) => [
        row.householdId,
        row.status === 'AUTH_FAILED' || row.status === 'CONNECTED'
          ? row.status
          : null,
      ]),
    );
  }
}

function toHouseholdListItem(
  household: HouseholdInfo,
  cookidoo: HouseholdListItem['cookidoo'] | undefined,
): HouseholdListItem {
  const latestOf = (
    pick: (m: HouseholdInfo['members'][number]) => Date | null,
  ) =>
    household.members.reduce<Date | null>((latest, member) => {
      const at = pick(member);
      return at && (!latest || at > latest) ? at : latest;
    }, null);
  const lastLogin = latestOf((m) => m.lastLoginAt);
  const lastSeen = latestOf((m) => m.lastSeenAt);
  return {
    id: household.id,
    name: household.name,
    plan: household.plan,
    members: household.members.map((member) => ({
      userId: member.userId,
      displayName: member.displayName,
      role: member.role,
      avatarColor: member.avatarColor,
    })),
    pool: SEARCH_POOL,
    cookidoo: cookidoo ?? null,
    lastLoginAt: lastLogin?.toISOString() ?? null,
    lastSeenAt: lastSeen?.toISOString() ?? null,
    createdAt: household.createdAt.toISOString(),
  };
}
