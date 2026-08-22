/**
 * Uzupełnia `Recipe.suitableMealTypes` — czyli odpowiada na pytanie
 * „które z istniejących dań nadają się na II śniadanie / podwieczorek /
 * przekąskę".
 *
 * Skrypt jest idempotentny i wyłącznie **dokłada** sloty: nigdy nie zabiera
 * tego, co ktoś ustawił ręcznie. Klasyfikacja siedzi w
 * `src/recipes/suitable-meal-types.util.ts`, tutaj jest tylko przejście po
 * bazie i raport.
 *
 * Użycie:
 *   pnpm recipes:backfill:slots -- --dry-run
 *   pnpm recipes:backfill:slots
 *
 * `--dry-run` niczego nie zapisuje, tylko wypisuje tabelę „danie → sloty",
 * żeby dało się to przejrzeć przed puszczeniem na produkcji.
 */
import { PrismaClient } from '@prisma/client';
import {
  resolveSuitableMealTypes,
  suggestExtraMealTypes,
} from '../src/recipes/suitable-meal-types.util';

const prisma = new PrismaClient();

const MEAL_TYPE_LABELS: Record<string, string> = {
  BREAKFAST: 'Śniadanie',
  SECOND_BREAKFAST: 'II śniadanie',
  LUNCH: 'Obiad',
  AFTERNOON_SNACK: 'Podwieczorek',
  DINNER: 'Kolacja',
  SNACK: 'Przekąska',
};

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const recipes = await prisma.recipe.findMany({
    where: { isActive: true },
    select: {
      id: true,
      title: true,
      description: true,
      mealType: true,
      suitableMealTypes: true,
      prepTimeMinutes: true,
      servings: true,
      nutritionKcal: true,
    },
    orderBy: [{ mealType: 'asc' }, { title: 'asc' }],
  });

  let changed = 0;
  const perSlot = new Map<string, number>();

  for (const recipe of recipes) {
    const suggestions = suggestExtraMealTypes(recipe);
    const resolved = resolveSuitableMealTypes(recipe);
    const current = [...recipe.suitableMealTypes].sort().join(',');
    const next = [...resolved].sort().join(',');

    if (current === next) continue;
    changed += 1;

    for (const suggestion of suggestions) {
      perSlot.set(
        suggestion.mealType,
        (perSlot.get(suggestion.mealType) ?? 0) + 1,
      );
    }

    const added = suggestions
      .map((s) => `${MEAL_TYPE_LABELS[s.mealType]} (${s.reason})`)
      .join(', ');
    console.log(
      `${MEAL_TYPE_LABELS[recipe.mealType].padEnd(12)} ${recipe.title.slice(0, 48).padEnd(50)} + ${added || '— (tylko uzupełnienie slotu bazowego)'}`,
    );

    if (!dryRun) {
      await prisma.recipe.update({
        where: { id: recipe.id },
        data: { suitableMealTypes: resolved },
      });
    }
  }

  console.log('');
  console.log(`Przepisów w bazie:      ${recipes.length}`);
  console.log(`Do zmiany:              ${changed}`);
  for (const [mealType, count] of perSlot) {
    console.log(`  + ${MEAL_TYPE_LABELS[mealType].padEnd(14)} ${count} dań`);
  }
  console.log(dryRun ? '\nDRY RUN — nic nie zapisano.' : '\nZapisano.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
