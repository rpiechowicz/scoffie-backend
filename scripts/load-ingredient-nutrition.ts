/**
 * Wgrywa wartości odżywcze składników (na 100 g / 100 ml) z katalogu do bazy.
 *
 * Tabela w `prisma/catalog/ingredient-nutrition-pl-v1.json` jest źródłem prawdy
 * — plik jest wersjonowany w gicie i przeglądany ręcznie, baza jest tylko jego
 * odbiciem. Skrypt jest idempotentny: można go puścić po każdej korekcie tabeli.
 *
 * Dopasowanie idzie po `normalizedName` — to jedyny klucz stabilny między
 * katalogiem a bazą (nazwy wyświetlane mają polskie znaki, katalog nie).
 *
 * Zapis idzie parametryzowanym SQL-em, a nie typowanym klientem, żeby skrypt
 * działał także zanim ktoś przepuści `prisma generate` po migracji
 * `20260820120000_ingredient_nutrition_per_100`.
 *
 * Uruchomienie:
 *   pnpm catalog:ingredients:nutrition
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const NUTRITION_FILE =
  process.env.INGREDIENT_NUTRITION_FILE ??
  'prisma/catalog/ingredient-nutrition-pl-v1.json';

type NutritionEntry = {
  normalizedName: string;
  unit: 'g' | 'ml' | 'szt';
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  gramsPerPiece?: number;
};

type NutritionCatalog = {
  version: string;
  ingredients: NutritionEntry[];
};

/**
 * Kontrola spójności wewnętrznej: energia policzona ze współczynników Atwatera
 * (4 kcal/g białka i węgli, 9 kcal/g tłuszczu, 2 kcal/g błonnika) powinna
 * zgadzać się z deklarowanym kcal. Rozjazd oznacza literówkę w tabeli — lepiej
 * złapać ją tutaj niż zobaczyć w makro przepisu.
 */
function atwaterDeviation(entry: NutritionEntry): number | null {
  if (entry.kcal <= 20) return null; // przy śladowych wartościach % nic nie mówi
  const computed =
    4 * entry.protein + 4 * entry.carbs + 9 * entry.fat + 2 * entry.fiber;
  return (computed - entry.kcal) / entry.kcal;
}

async function main(): Promise<void> {
  const raw = await readFile(join(process.cwd(), NUTRITION_FILE), 'utf8');
  const catalog = JSON.parse(raw) as NutritionCatalog;

  let updated = 0;
  const missing: string[] = [];

  for (const entry of catalog.ingredients) {
    if (entry.unit === 'szt' && !entry.gramsPerPiece) {
      throw new Error(
        `${entry.normalizedName}: jednostka "szt" bez gramsPerPiece — nie da się policzyć makro`,
      );
    }

    const deviation = atwaterDeviation(entry);
    if (deviation !== null && Math.abs(deviation) > 0.2) {
      const fromAtwater = Math.round(
        4 * entry.protein + 4 * entry.carbs + 9 * entry.fat + 2 * entry.fiber,
      );

      console.warn(
        `[nutrition] podejrzana pozycja ${entry.normalizedName}: kcal=${entry.kcal}, z Atwatera=${fromAtwater} (${Math.round(deviation * 100)}%)`,
      );
    }

    const count = await prisma.$executeRaw`
      UPDATE "Ingredient"
      SET "nutritionKcalPer100"    = ${entry.kcal},
          "nutritionProteinPer100" = ${entry.protein},
          "nutritionCarbsPer100"   = ${entry.carbs},
          "nutritionFatPer100"     = ${entry.fat},
          "nutritionFiberPer100"   = ${entry.fiber},
          "gramsPerPiece"          = ${entry.gramsPerPiece ?? null},
          "nutritionSource"        = ${catalog.version},
          "updatedAt"              = now()
      WHERE "normalizedName" = ${entry.normalizedName}
    `;

    if (count === 0) {
      missing.push(entry.normalizedName);
    } else {
      updated += count;
    }
  }

  if (missing.length > 0) {
    console.warn(
      `[nutrition] brak w bazie (${missing.length}): ${missing.join(', ')}`,
    );
  }

  // Składniki realnie używane w przepisach, którym po wgraniu wciąż brakuje
  // makro — to one zaniżą audyt, więc raportujemy je głośno.
  const uncovered = await prisma.$queryRaw<Array<{ normalizedName: string }>>`
    SELECT DISTINCT i."normalizedName"
    FROM "Ingredient" i
    JOIN "RecipeIngredient" ri ON ri."ingredientId" = i.id
    WHERE i."nutritionKcalPer100" IS NULL
    ORDER BY i."normalizedName"
  `;

  console.log(
    `[nutrition] done. version=${catalog.version}, wpisow=${catalog.ingredients.length}, zaktualizowanych=${updated}`,
  );

  if (uncovered.length > 0) {
    console.warn(
      `[nutrition] UWAGA: ${uncovered.length} skladnikow uzywanych w przepisach nadal bez makro: ${uncovered
        .map((row) => row.normalizedName)
        .join(', ')}`,
    );
  }
}

main()
  .catch((error) => {
    console.error('Ingredient nutrition load failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
