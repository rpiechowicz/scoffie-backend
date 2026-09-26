/**
 * Syntetyczny, DETERMINISTYCZNY świat do sondy skali (workstream, Etap 4).
 *
 * Żyje WYŁĄCZNIE w osobnej bazie (nazwa kończy się na `_scale`) — nigdy
 * w bazie dev z prawdziwym katalogiem. Ten sam `seed` i te same rozmiary dają
 * bajt w bajt te same dane (identyfikatory też), więc wyniki przed/po są
 * porównywalne.
 *
 * Jak powstaje:
 * - 1 dom katalogowy + autor (id jak `RECIPE_IMPORT_HOUSEHOLD_ID` domyślnie),
 * - `ingredients` składników z makrami na 100 g (co 7. z glutenem, co 11.
 *   z laktozą, co 5. mięsny),
 * - `recipes` przepisów katalogu: pora rotacyjnie, 5–10 składników z puli,
 *   makra = suma składników, alergeny/tagi diety = unia składników,
 * - `households` domów po 2 osoby, każdy z `weeks` tygodniami pełnego planu
 *   (śniadanie, obiad, kolacja × 7) — tabela `PlanItem` pod popularność.
 */
import { PrismaClient, MealType, Prisma } from '@prisma/client';

export const SCALE_CATALOG_HOUSEHOLD = '22222222-2222-4222-8222-222222222222';
export const SCALE_AUTHOR = '11111111-1111-4111-8111-111111111111';
export const SCALE_WEEK_START = '2026-09-28';

export type ScaleSize = {
  recipes: number;
  ingredients: number;
  households: number;
  weeks: number;
};

/** mulberry32 — mały, szybki, deterministyczny. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** UUID v4 z generatora — te same dane = te same identyfikatory. */
export function uuidFrom(next: () => number): string {
  const hex = Array.from({ length: 32 }, () =>
    Math.floor(next() * 16).toString(16),
  );
  hex[12] = '4';
  hex[16] = ['8', '9', 'a', 'b'][Math.floor(next() * 4)];
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

const MEALS: MealType[] = ['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK'];
const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;

export function assertScaleDatabase(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.endsWith('_scale')) {
    throw new Error(
      `Sonda skali pisze WYŁĄCZNIE do bazy *_scale (dostała: ${name}). Ustaw SCALE_DATABASE_URL.`,
    );
  }
}

/** Czyści świat sondy (tylko baza *_scale). */
export async function resetScaleWorld(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "PlanItem", "WeeklyPlan", "RecipeFavorite", "RecipeIngredient",
      "Recipe", "Ingredient", "Membership", "ShoppingListItem", "ShoppingList",
      "AgentMessage", "AgentTurn", "AgentConversation", "Household", "User"
      RESTART IDENTITY CASCADE`,
  );
  // Log synchronizacji katalogu (Etap 4) — od zera, z nową epoką; w kodzie
  // sprzed Etapu 4 tych tabel nie ma.
  const hasLog = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(
    `SELECT to_regclass('"CatalogChange"') IS NOT NULL AS "exists"`,
  );
  if (hasLog[0]?.exists) {
    await prisma.$executeRawUnsafe(`TRUNCATE "CatalogChange" RESTART IDENTITY`);
    await prisma.$executeRawUnsafe(
      `UPDATE "CatalogSyncState" SET "epoch" = gen_random_uuid(), "minRevision" = 0 WHERE "id" = 1`,
    );
  }
}

export type ScaleWorld = {
  catalogRecipeIds: string[];
  householdIds: string[];
  /** Pierwszy dom z dwiema osobami — do ścieżek asystenta i listy zakupów. */
  probe: { householdId: string; userIds: [string, string] };
};

export async function seedScaleWorld(
  prisma: PrismaClient,
  size: ScaleSize,
  seed = 20260926,
): Promise<ScaleWorld> {
  const next = rng(seed);
  await prisma.user.create({
    data: {
      id: SCALE_AUTHOR,
      displayName: 'Katalog',
      email: 'katalog@scale.local',
      authProvider: 'DEV',
    },
  });
  await prisma.household.create({
    data: {
      id: SCALE_CATALOG_HOUSEHOLD,
      name: 'Katalog',
      createdById: SCALE_AUTHOR,
    },
  });

  const ingredients = Array.from({ length: size.ingredients }, (_, i) => ({
    id: uuidFrom(next),
    name: `Składnik ${i}`,
    normalizedName: `skladnik ${i}`,
    category: ['warzywa', 'nabiał', 'mięso', 'zboża', 'przyprawy'][i % 5],
    nutritionKcalPer100: 40 + Math.floor(next() * 400),
    nutritionProteinPer100: Math.round(next() * 30),
    nutritionCarbsPer100: Math.round(next() * 60),
    nutritionFatPer100: Math.round(next() * 25),
    nutritionFiberPer100: Math.round(next() * 8),
    nutritionSodiumMgPer100: Math.round(next() * 400),
    allergens: [
      ...(i % 7 === 0 ? ['gluten'] : []),
      ...(i % 11 === 0 ? ['lactose'] : []),
    ],
    dietTags: i % 5 === 2 ? ['MEAT'] : [],
  }));
  await prisma.ingredient.createMany({ data: ingredients });

  const recipeIds: string[] = [];
  const base = Date.UTC(2026, 0, 1);
  for (let start = 0; start < size.recipes; start += 1000) {
    const recipes: Prisma.RecipeCreateManyInput[] = [];
    const rows: Prisma.RecipeIngredientCreateManyInput[] = [];
    for (let i = start; i < Math.min(size.recipes, start + 1000); i += 1) {
      const id = uuidFrom(next);
      recipeIds.push(id);
      const meal = MEALS[i % MEALS.length];
      const count = 5 + Math.floor(next() * 6);
      const picked = new Set<number>();
      while (picked.size < count) {
        picked.add(Math.floor(next() * ingredients.length));
      }
      let kcal = 0;
      let protein = 0;
      let fat = 0;
      let carbs = 0;
      const allergens = new Set<string>();
      const diet = new Set<string>();
      let order = 0;
      for (const index of picked) {
        const ingredient = ingredients[index];
        const grams = 40 + Math.floor(next() * 200);
        kcal += (ingredient.nutritionKcalPer100 * grams) / 100;
        protein += (ingredient.nutritionProteinPer100 * grams) / 100;
        fat += (ingredient.nutritionFatPer100 * grams) / 100;
        carbs += (ingredient.nutritionCarbsPer100 * grams) / 100;
        ingredient.allergens.forEach((a) => allergens.add(a));
        ingredient.dietTags.forEach((d) => diet.add(d));
        rows.push({
          id: uuidFrom(next),
          recipeId: id,
          ingredientId: ingredient.id,
          name: ingredient.name,
          amount: grams,
          unit: 'g',
          normalizedAmount: grams,
          normalizedUnit: 'g',
          department: ingredient.category,
          createdAt: new Date(base + i * 1000 + order++),
        });
      }
      recipes.push({
        id,
        title: `Danie ${String(i).padStart(5, '0')}`,
        description: `Syntetyczne danie numer ${i}.`,
        mealType: meal,
        suitableMealTypes: [meal],
        prepTimeMinutes: 10 + Math.floor(next() * 80),
        servings: 1 + Math.floor(next() * 4),
        imageUrl: `https://img.scoffie.app/scale/${i}.webp`,
        nutritionKcal: Math.round(kcal),
        nutritionProtein: Math.round(protein),
        nutritionFat: Math.round(fat),
        nutritionCarbs: Math.round(carbs),
        isActive: true,
        isCatalog: true,
        allergens: [...allergens],
        dietTags: [...diet],
        authorId: SCALE_AUTHOR,
        householdId: SCALE_CATALOG_HOUSEHOLD,
        createdAt: new Date(base + i * 1000),
      });
    }
    await prisma.recipe.createMany({ data: recipes });
    await prisma.recipeIngredient.createMany({ data: rows });
  }

  const pools = new Map<MealType, string[]>(
    MEALS.map((meal) => [
      meal,
      recipeIds.filter((_, index) => MEALS[index % MEALS.length] === meal),
    ]),
  );
  const householdIds: string[] = [];
  let probe: ScaleWorld['probe'] | null = null;
  const weekStart = new Date(`${SCALE_WEEK_START}T00:00:00.000Z`);
  for (let h = 0; h < size.households; h += 1) {
    const users = [uuidFrom(next), uuidFrom(next)] as [string, string];
    await prisma.user.createMany({
      data: users.map((id, k) => ({
        id,
        displayName: `Osoba ${h}-${k}`,
        email: `osoba-${h}-${k}@scale.local`,
        authProvider: 'DEV' as const,
      })),
    });
    const householdId = uuidFrom(next);
    householdIds.push(householdId);
    await prisma.household.create({
      data: { id: householdId, name: `Dom ${h}`, createdById: users[0] },
    });
    await prisma.membership.createMany({
      data: users.map((userId, k) => ({
        userId,
        householdId,
        role: k === 0 ? ('OWNER' as const) : ('MEMBER' as const),
      })),
    });
    const items: Prisma.PlanItemCreateManyInput[] = [];
    for (let w = 0; w < size.weeks; w += 1) {
      const planId = uuidFrom(next);
      await prisma.weeklyPlan.create({
        data: {
          id: planId,
          householdId,
          weekStart: new Date(weekStart.getTime() - w * 7 * 86400000),
        },
      });
      for (const day of DAYS) {
        for (const meal of ['BREAKFAST', 'LUNCH', 'DINNER'] as const) {
          const pool = pools.get(meal) ?? [];
          items.push({
            weeklyPlanId: planId,
            recipeId: pool[Math.floor(next() * pool.length)],
            dayOfWeek: day,
            mealType: meal,
            plannedServings: 2,
          });
        }
      }
    }
    await prisma.planItem.createMany({ data: items, skipDuplicates: true });
    probe ??= { householdId, userIds: users };
  }
  if (!probe) throw new Error('świat bez domu — households >= 1');
  return { catalogRecipeIds: recipeIds, householdIds, probe };
}
