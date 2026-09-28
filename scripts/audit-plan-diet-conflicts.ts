/**
 * Pomiar pod decyzję S5 (N8A): ile zapisanych pozycji planu łamie dietę
 * kogoś z jedzących?
 *
 * Walidator zapisu (`collectPlanViolations`) sprawdza alergeny i wykluczenia,
 * ale NIE dietę — planer i wyszukiwarka dietę sprawdzają. Zanim zapis zacznie
 * odmawiać, trzeba wiedzieć, ile dzisiejszych planów takiej reguły by nie
 * przeszło (ryzyko R3 z raportu N8A: nowa reguła odrzuci zapis tygodnia, który
 * wczoraj przechodził).
 *
 * Tylko czyta. Drukuje WYŁĄCZNIE sumy (bez id, nazw i danych osób) — diety
 * i alergeny to dane o zdrowiu. Reguły = wspólny silnik (`recipe-constraints`),
 * więc wynik jest dokładnie tym, co zobaczyłby walidator po zmianie.
 *
 * Uruchomienie (lokalnie albo na prod przez `railway ssh`, siecią prywatną):
 *   pnpm exec tsx scripts/audit-plan-diet-conflicts.ts
 *   pnpm exec tsx scripts/audit-plan-diet-conflicts.ts -- --from 2026-09-21
 */
import { DietPreferenceValue, PrismaClient } from '@prisma/client';
import {
  allergenConflicts,
  AudienceSubject,
  excludedIngredientHits,
  subjectSatisfiesDiet,
} from '../src/recipes/constraints/recipe-constraints';
import { nutritionPerServing } from '../src/recipes/diet-rules.util';

const prisma = new PrismaClient();
const PAGE = 200;

type Profile = {
  diet: DietPreferenceValue;
  allergens: string[];
  excludedIngredientIds: string[];
};

function parseFrom(argv: string[]): Date | null {
  const at = argv.indexOf('--from');
  if (at < 0) return null;
  const value = argv[at + 1];
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!value || Number.isNaN(date.getTime())) {
    throw new Error(`--from wymaga daty RRRR-MM-DD, dostało: ${value}`);
  }
  return date;
}

/** Poniedziałek bieżącego tygodnia (UTC) — granica „przeszłe / bieżące i przyszłe”. */
function currentWeekStart(now = new Date()): Date {
  const day = (now.getUTCDay() + 6) % 7;
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day),
  );
}

async function main(): Promise<void> {
  const from = parseFrom(process.argv.slice(2));
  const boundary = currentWeekStart();
  const stats = {
    items: 0,
    itemsWithDietaryAudience: 0,
    dietConflicts: 0,
    dietConflictsCurrentOrFuture: 0,
    householdsWithDietConflict: 0,
    byDiet: {} as Record<string, number>,
    byRecipeSource: { catalog: 0, household: 0 },
    // Kontrola spójności: te reguły zapis JUŻ egzekwuje, więc tu powinno być
    // 0 (poza danymi sprzed reguły albo zmianą profilu po zapisie).
    allergenConflicts: 0,
    exclusionConflicts: 0,
  };
  const conflictHouseholds = new Set<string>();
  const profiles = new Map<string, Profile>();

  for (let cursor: string | undefined; ;) {
    const plans = await prisma.weeklyPlan.findMany({
      where: from ? { weekStart: { gte: from } } : {},
      orderBy: { id: 'asc' },
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        householdId: true,
        weekStart: true,
        household: {
          select: {
            memberships: {
              select: {
                userId: true,
                user: {
                  select: {
                    preferences: {
                      select: {
                        dietPreference: true,
                        allergens: true,
                        excludedIngredientIds: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        items: {
          select: {
            participants: { select: { userId: true } },
            recipe: {
              select: {
                isCatalog: true,
                servings: true,
                nutritionKcal: true,
                nutritionProtein: true,
                nutritionCarbs: true,
                nutritionFat: true,
                allergens: true,
                dietTags: true,
                ingredients: { select: { ingredientId: true } },
              },
            },
          },
        },
      },
    });
    if (plans.length === 0) break;
    cursor = plans[plans.length - 1].id;

    for (const plan of plans) {
      const memberIds = plan.household.memberships.map((m) => m.userId);
      for (const membership of plan.household.memberships) {
        const pref = membership.user.preferences;
        profiles.set(membership.userId, {
          diet: pref?.dietPreference ?? 'NONE',
          allergens: pref?.allergens ?? [],
          excludedIngredientIds: pref?.excludedIngredientIds ?? [],
        });
      }
      for (const item of plan.items) {
        stats.items += 1;
        const named = item.participants.map((p) => p.userId);
        // Ta sama reguła audytorium co zapis: puste = cały dom; osoby spoza
        // domu (były domownik) nie mają profilu w tym domu — pomijamy.
        const audience = (named.length > 0 ? named : memberIds)
          .map((id) => profiles.get(id))
          .filter((profile): profile is Profile => Boolean(profile));
        const subject: AudienceSubject = {
          allergens: item.recipe.allergens,
          ingredientIds: item.recipe.ingredients.map((i) => i.ingredientId),
          dietTags: item.recipe.dietTags,
          perServing: nutritionPerServing(item.recipe),
        };
        if (
          allergenConflicts(subject, {
            allergens: audience.flatMap((p) => p.allergens),
          }).length > 0
        ) {
          stats.allergenConflicts += 1;
        }
        if (
          excludedIngredientHits(subject, {
            excludedIngredientIds: audience.flatMap(
              (p) => p.excludedIngredientIds,
            ),
          }).length > 0
        ) {
          stats.exclusionConflicts += 1;
        }
        const diets = [
          ...new Set(audience.map((p) => p.diet).filter((d) => d !== 'NONE')),
        ];
        if (diets.length === 0) continue;
        stats.itemsWithDietaryAudience += 1;
        const broken = diets.filter(
          (diet) => !subjectSatisfiesDiet(subject, diet),
        );
        if (broken.length === 0) continue;
        stats.dietConflicts += 1;
        if (plan.weekStart >= boundary) stats.dietConflictsCurrentOrFuture += 1;
        conflictHouseholds.add(plan.householdId);
        if (item.recipe.isCatalog) stats.byRecipeSource.catalog += 1;
        else stats.byRecipeSource.household += 1;
        for (const diet of broken) {
          stats.byDiet[diet] = (stats.byDiet[diet] ?? 0) + 1;
        }
      }
    }
  }
  stats.householdsWithDietConflict = conflictHouseholds.size;
  process.stdout.write(
    `${JSON.stringify(
      {
        from: from?.toISOString().slice(0, 10) ?? 'wszystkie tygodnie',
        currentWeekStart: boundary.toISOString().slice(0, 10),
        ...stats,
      },
      null,
      2,
    )}\n`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
