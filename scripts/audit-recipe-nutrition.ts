/**
 * Porównuje makro zapisane przy przepisie z makro policzonym ze składników.
 *
 * Powstało po audycie bazy v1, gdzie wartości były wpisane z ręki i nigdy nie
 * liczone: mediana odchyłki wynosiła +43%, skrajność +87%, a 27 z 30 przepisów
 * leżało poza progiem 10%. Skrypt ma sprawić, że taki stan nie wróci niezauważony.
 *
 * Domyślnie tylko czyta i drukuje raport — niczego nie zapisuje. Rozjazd bywa
 * winą listy składników, a nie makro, więc decyzja "co poprawić" należy do
 * człowieka.
 *
 * Kod wyjścia 1, gdy cokolwiek wychodzi poza próg — nadaje się do CI.
 *
 * Uruchomienie:
 *   pnpm audit:recipes:nutrition
 *   pnpm audit:recipes:nutrition -- --tolerance 0.15
 *   pnpm audit:recipes:nutrition -- --json
 */
import { PrismaClient } from '@prisma/client';
import {
  NUTRITION_TOLERANCE,
  computeRecipeNutrition,
  relativeDeviation,
  roundTotals,
  type NutritionInputItem,
} from '../src/recipes/recipe-nutrition.util';

const prisma = new PrismaClient();

type Row = {
  recipeId: string;
  title: string;
  servings: number;
  storedKcal: number;
  storedProtein: number;
  storedCarbs: number;
  storedFat: number;
  storedFiber: number;
  ingredientName: string;
  normalizedAmount: number;
  normalizedUnit: string;
  kcalPer100: number | null;
  proteinPer100: number | null;
  carbsPer100: number | null;
  fatPer100: number | null;
  fiberPer100: number | null;
  gramsPerPiece: number | null;
};

function parseArgs(argv: string[]): { tolerance: number; json: boolean } {
  const toleranceIndex = argv.indexOf('--tolerance');
  const tolerance =
    toleranceIndex >= 0
      ? Number.parseFloat(argv[toleranceIndex + 1] ?? '')
      : NUTRITION_TOLERANCE;

  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    throw new Error('--tolerance oczekuje liczby dodatniej, np. 0.15');
  }

  return { tolerance, json: argv.includes('--json') };
}

function formatPercent(value: number | null): string {
  if (value === null) return '   —';
  const rounded = Math.round(value * 100);
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

async function main(): Promise<void> {
  const { tolerance, json } = parseArgs(process.argv.slice(2));

  // Jeden przelot po bazie zamiast zapytania na przepis — 30 przepisów dziś,
  // ale zapytanie w pętli zestarzeje się źle. Surowy SQL, bo kolumny per-100
  // doszły migracją i skrypt ma działać bez `prisma generate`.
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT r.id                      AS "recipeId",
           r.title                   AS "title",
           r.servings                AS "servings",
           r."nutritionKcal"         AS "storedKcal",
           r."nutritionProtein"      AS "storedProtein",
           r."nutritionCarbs"        AS "storedCarbs",
           r."nutritionFat"          AS "storedFat",
           r."nutritionFiber"        AS "storedFiber",
           ri.name                   AS "ingredientName",
           ri."normalizedAmount"     AS "normalizedAmount",
           ri."normalizedUnit"       AS "normalizedUnit",
           i."nutritionKcalPer100"   AS "kcalPer100",
           i."nutritionProteinPer100" AS "proteinPer100",
           i."nutritionCarbsPer100"  AS "carbsPer100",
           i."nutritionFatPer100"    AS "fatPer100",
           i."nutritionFiberPer100"  AS "fiberPer100",
           i."gramsPerPiece"         AS "gramsPerPiece"
    FROM "Recipe" r
    JOIN "RecipeIngredient" ri ON ri."recipeId" = r.id
    JOIN "Ingredient" i ON i.id = ri."ingredientId"
    WHERE r."isActive" = true
    ORDER BY r.title
  `;

  const byRecipe = new Map<string, { row: Row; items: NutritionInputItem[] }>();

  for (const row of rows) {
    let entry = byRecipe.get(row.recipeId);
    if (!entry) {
      entry = { row, items: [] };
      byRecipe.set(row.recipeId, entry);
    }

    entry.items.push({
      name: row.ingredientName,
      normalizedAmount: row.normalizedAmount,
      normalizedUnit: row.normalizedUnit,
      nutrition:
        row.kcalPer100 === null
          ? null
          : {
              kcal: row.kcalPer100,
              protein: row.proteinPer100 ?? 0,
              carbs: row.carbsPer100 ?? 0,
              fat: row.fatPer100 ?? 0,
              fiber: row.fiberPer100 ?? 0,
              gramsPerPiece: row.gramsPerPiece,
            },
    });
  }

  const report = [...byRecipe.values()]
    .map(({ row, items }) => {
      const { totals, missingNutrition, missingPieceWeight } =
        computeRecipeNutrition(items);
      const computed = roundTotals(totals);

      return {
        title: row.title,
        servings: row.servings,
        stored: {
          kcal: row.storedKcal,
          protein: row.storedProtein,
          carbs: row.storedCarbs,
          fat: row.storedFat,
          fiber: row.storedFiber,
        },
        computed,
        deviation: {
          kcal: relativeDeviation(computed.kcal, row.storedKcal),
          protein: relativeDeviation(computed.protein, row.storedProtein),
          carbs: relativeDeviation(computed.carbs, row.storedCarbs),
          fat: relativeDeviation(computed.fat, row.storedFat),
        },
        perServing: {
          stored: Math.round(row.storedKcal / Math.max(row.servings, 1)),
          computed: Math.round(computed.kcal / Math.max(row.servings, 1)),
        },
        missingNutrition,
        missingPieceWeight,
      };
    })
    .sort(
      (a, b) =>
        Math.abs(b.deviation.kcal ?? 0) - Math.abs(a.deviation.kcal ?? 0),
    );

  // Prog liczymy po calym makro, nie po samym kcal. Przepis potrafi trafic
  // energie i jednoczesnie miec bialko zanizone o polowe — a to wciaz zle dane.
  const worstDeviation = (item: (typeof report)[number]): number =>
    Math.max(
      ...[
        item.deviation.kcal,
        item.deviation.protein,
        item.deviation.carbs,
        item.deviation.fat,
      ].map((value) => Math.abs(value ?? 0)),
    );

  const offenders = report.filter((item) => worstDeviation(item) > tolerance);

  if (json) {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({ tolerance, total: report.length, report }, null, 2),
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(
      `\nAudyt makro — ${report.length} przepisow, prog ${Math.round(tolerance * 100)}%\n` +
        `(kcal w bazie = caly przepis; kolumna "porcja" dzieli przez servings)\n`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `${'przepis'.padEnd(46)}${'baza'.padStart(7)}${'wylicz'.padStart(8)}${'kcal'.padStart(7)}${'B'.padStart(6)}${'W'.padStart(6)}${'T'.padStart(6)}${'porcja'.padStart(14)}`,
    );

    for (const item of report) {
      const flag = worstDeviation(item) > tolerance ? ' !' : '  ';
      // eslint-disable-next-line no-console
      console.log(
        item.title.slice(0, 44).padEnd(46) +
          String(Math.round(item.stored.kcal)).padStart(7) +
          String(item.computed.kcal).padStart(8) +
          formatPercent(item.deviation.kcal).padStart(7) +
          formatPercent(item.deviation.protein).padStart(6) +
          formatPercent(item.deviation.carbs).padStart(6) +
          formatPercent(item.deviation.fat).padStart(6) +
          `${item.perServing.stored} -> ${item.perServing.computed}`.padStart(
            12,
          ) +
          flag,
      );
    }

    const gaps = report.filter(
      (item) =>
        item.missingNutrition.length > 0 || item.missingPieceWeight.length > 0,
    );

    for (const item of gaps) {
      // eslint-disable-next-line no-console
      console.warn(
        `\n[luka] ${item.title}: bez makro = ${item.missingNutrition.join(', ') || '—'}; ` +
          `bez masy sztuki = ${item.missingPieceWeight.join(', ') || '—'}`,
      );
    }

    // eslint-disable-next-line no-console
    console.log(
      `\nPoza progiem: ${offenders.length}/${report.length}. ` +
        `Srednia porcja: ${Math.round(
          report.reduce((sum, item) => sum + item.perServing.stored, 0) /
            report.length,
        )} -> ${Math.round(
          report.reduce((sum, item) => sum + item.perServing.computed, 0) /
            report.length,
        )} kcal\n`,
    );
  }

  if (offenders.length > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Recipe nutrition audit failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
