import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException } from '../../common/app-exception';
import { effectiveSuitableMealTypes } from '../../common/meal-types';
import { PrismaService } from '../../prisma/prisma.service';
import { RecipesCacheService } from '../../recipes/recipes-cache.service';
import {
  AdminAuditService,
  type AdminActor,
} from '../audit/admin-audit.service';
import type { Ingredient, RecipeDetail, RecipeListItem } from '../contract';
import { readOnlyQuery } from '../read-only-query';
import { inPlansByRecipe } from '../common/recipe-in-plans';
import {
  baseUnitFromUsage,
  comparePolish,
  kcalPerServing,
  stepsFromInstructions,
} from './catalog-math';

const recipeNotFound = () =>
  new AppException(
    'RECIPE_NOT_FOUND',
    'Nie znaleziono przepisu w katalogu.',
    HttpStatus.NOT_FOUND,
  );

const listSelect = {
  id: true,
  title: true,
  imageUrl: true,
  isActive: true,
  mealType: true,
  prepTimeMinutes: true,
  nutritionKcal: true,
  servings: true,
} satisfies Prisma.RecipeSelect;

type ListRow = Prisma.RecipeGetPayload<{ select: typeof listSelect }>;

/**
 * Katalog przepisów i składników w panelu (ROADMAPA §5.7).
 *
 * WYŁĄCZNIE wspólny katalog (`isCatalog = true`): przepisy prywatne domów to
 * dane domu — panel nie pokazuje ich treści ani nie przyznaje, że istnieją
 * (szczegół spoza katalogu = 404, jak w `RecipesService.findById`).
 */
@Injectable()
export class AdminCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    private readonly recipesCache: RecipesCacheService,
  ) {}

  recipes(
    active: boolean | undefined,
    now: Date = new Date(),
  ): Promise<{ total: number; items: RecipeListItem[] }> {
    return readOnlyQuery(this.prisma, async (tx) => {
      const rows = await tx.recipe.findMany({
        where: {
          isCatalog: true,
          ...(active === undefined ? {} : { isActive: active }),
        },
        select: listSelect,
      });
      const plansOf = await inPlansByRecipe(tx, now, null);
      const favorites = await tx.recipeFavorite.groupBy({
        by: ['recipeId'],
        where: { recipe: { isCatalog: true } },
        _count: { _all: true },
      });
      const favoritesOf = new Map(
        favorites.map((row) => [row.recipeId, row._count._all]),
      );
      const items = rows
        .map((row) =>
          toListItem(
            row,
            plansOf.get(row.id) ?? 0,
            favoritesOf.get(row.id) ?? 0,
          ),
        )
        .sort((a, b) =>
          comparePolish(
            { text: a.title, id: a.id },
            { text: b.title, id: b.id },
          ),
        );
      // `total` = liczba przepisów pod TYM filtrem (jak w danych przykładowych
      // panelu); bez filtra — cały katalog, który panel podpisuje „N przepisów”.
      // Lista nie jest stronicowana (katalog ma ~500 pozycji), więc to po
      // prostu długość listy.
      return { total: items.length, items };
    });
  }

  recipe(id: string, now: Date = new Date()): Promise<RecipeDetail> {
    return readOnlyQuery(this.prisma, async (tx) => {
      const recipe = await tx.recipe.findFirst({
        where: { id, isCatalog: true },
        select: {
          ...listSelect,
          description: true,
          difficulty: true,
          suitableMealTypes: true,
          sourceInstructions: true,
          allergens: true,
          dietTags: true,
          updatedAt: true,
          ingredients: {
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: {
              amount: true,
              unit: true,
              ingredient: { select: { normalizedName: true } },
            },
          },
        },
      });
      if (!recipe) throw recipeNotFound();
      const inPlans = (await inPlansByRecipe(tx, now, [id])).get(id) ?? 0;
      const favorites = await tx.recipeFavorite.count({
        where: { recipeId: id },
      });
      return {
        ...toListItem(recipe, inPlans, favorites),
        description: recipe.description ?? '',
        difficulty: recipe.difficulty,
        servings: recipe.servings,
        // Pusta lista = wiersz sprzed backfillu; czytający dokładają slot
        // bazowy — ta sama reguła, co w aplikacji.
        suitableMealTypes: effectiveSuitableMealTypes(recipe),
        steps: stepsFromInstructions(recipe.sourceInstructions),
        // `key` = `Ingredient.normalizedName`, ten sam klucz, co w
        // `GET /admin/catalog/ingredients`; ilość i jednostka tak, jak zapisał
        // je przepis (także `szt`, łyżki, szczypty) — przeliczenie na gramy
        // robi panel tymi samymi przelicznikami, co `ingredient-amount.util`.
        ingredients: recipe.ingredients.map((line) => ({
          key: line.ingredient.normalizedName,
          amount: line.amount,
          unit: line.unit,
        })),
        allergens: recipe.allergens,
        dietTags: recipe.dietTags,
        updatedAt: recipe.updatedAt.toISOString(),
      };
    });
  }

  ingredients(): Promise<Ingredient[]> {
    return readOnlyQuery(this.prisma, async (tx) => {
      // Wszystkie składniki, także nieaktywne: linia przepisu wskazująca na
      // wycofany składnik musi się dać narysować w edytorze.
      const rows = await tx.ingredient.findMany({
        select: {
          id: true,
          normalizedName: true,
          name: true,
          nutritionKcalPer100: true,
          nutritionProteinPer100: true,
          nutritionCarbsPer100: true,
          nutritionFatPer100: true,
          nutritionFiberPer100: true,
          gramsPerPiece: true,
          allergens: true,
          dietTags: true,
        },
      });
      // Jednostki, w których przepisy KATALOGU odmierzają składnik — z nich
      // bierze się podstawa „na 100 g / 100 ml” (patrz `baseUnitFromUsage`).
      // Przepisy domów pomijamy: tam jednostkę wybiera asystent albo człowiek.
      const usage = await tx.$queryRaw<
        { ingredientId: string; grams: number; millilitres: number }[]
      >(Prisma.sql`
        SELECT
          ri."ingredientId"::text AS "ingredientId",
          COUNT(*) FILTER (WHERE ri."normalizedUnit" = 'g')::int AS grams,
          COUNT(*) FILTER (WHERE ri."normalizedUnit" = 'ml')::int AS millilitres
        FROM "RecipeIngredient" ri
        JOIN "Recipe" r ON r.id = ri."recipeId" AND r."isCatalog" = true
        GROUP BY ri."ingredientId"
      `);
      const usageOf = new Map(usage.map((row) => [row.ingredientId, row]));
      return rows
        .map(
          (row): Ingredient => ({
            key: row.normalizedName,
            name: row.name,
            unit: baseUnitFromUsage(
              usageOf.get(row.id) ?? { grams: 0, millilitres: 0 },
            ),
            // Składnik bez makro (luka w danych, audyt ją zgłasza) ma w
            // kontrakcie liczby — 0, tak jak pomija go liczenie makro przepisu.
            kcal: row.nutritionKcalPer100 ?? 0,
            protein: row.nutritionProteinPer100 ?? 0,
            // Węglowodany przyswajalne, BEZ błonnika (konwencja IŻŻ, kolumna
            // `nutritionCarbsPer100`) — błonnik osobno.
            carbs: row.nutritionCarbsPer100 ?? 0,
            fat: row.nutritionFatPer100 ?? 0,
            fiber: row.nutritionFiberPer100 ?? 0,
            gramsPerPiece: row.gramsPerPiece,
            allergens: row.allergens,
            dietTags: row.dietTags,
          }),
        )
        .sort((a, b) =>
          comparePolish(
            { text: a.name, id: a.key },
            { text: b.name, id: b.key },
          ),
        );
    });
  }

  /**
   * Wycofanie / przywrócenie przepisu katalogu — narzędzie moderacji (np.
   * złe makro po zgłoszeniu). Wycofany przepis znika z listy i szczegółu
   * w aplikacji, z digestu asystenta i z bramki wstawiania do planu (wszystkie
   * filtrują `isActive`); pozycje, które już stoją w planach, zostają.
   *
   * Domena nie ma serwisu do tej operacji: `RecipesService.remove` obsługuje
   * wyłącznie przepisy domu (katalog = `RECIPE_NOT_EDITABLE`) i odmawia, gdy
   * przepis stoi w planie — moderacja katalogu musi zadziałać także wtedy.
   * Stąd zapis tutaj, z tym samym skutkiem ubocznym co domena: unieważnienie
   * cache listy przepisów.
   *
   * A IMPORT KATALOGU? `scripts/import-recipes-from-json.ts` w zwykłym trybie
   * (upsert po id) NIE zapisuje `isActive`, więc wycofanie przeżywa kolejny
   * import. Cofa je dopiero `RECIPE_IMPORT_CLEAR_EXISTING=true`: skasowanie
   * i założenie katalogu od nowa (domyślnie `isActive = true`, przy okazji
   * znikają pozycje planów). I odwrotnie: poprawka przepisu w JSON-ie + import
   * NIE przywraca wycofanego — trzeba to zrobić tutaj.
   */
  async setActive(
    actor: AdminActor,
    id: string,
    isActive: boolean,
    reason: string,
    now: Date = new Date(),
  ): Promise<void> {
    await this.audit.run(
      actor,
      {
        action: 'recipe.active.set',
        targetType: 'Recipe',
        targetId: id,
        reason,
        details: { to: isActive },
      },
      () =>
        this.prisma.$transaction(async (tx) => {
          const recipe = await tx.recipe.findFirst({
            where: { id, isCatalog: true },
            select: { isActive: true },
          });
          if (!recipe) throw recipeNotFound();
          if (recipe.isActive !== isActive) {
            await tx.recipe.update({ where: { id }, data: { isActive } });
          }
          const inPlans = (await inPlansByRecipe(tx, now, [id])).get(id) ?? 0;
          return { from: recipe.isActive, to: isActive, inPlans };
        }),
      (result) => result,
    );
    // Cache listy żyje w pamięci procesu (`RecipesCacheService`) — bez tego
    // wycofany przepis wisiałby w katalogu aplikacji do końca TTL (90 s).
    this.recipesCache.invalidateRecipesList();
  }
}

function toListItem(
  row: ListRow,
  inPlans: number,
  favorites: number,
): RecipeListItem {
  return {
    id: row.id,
    title: row.title,
    // Katalog ma zdjęcia pod img.scoffie.app; przepis bez zdjęcia dostaje
    // pusty adres (panel rysuje wtedy zastępnik), a nie wygenerowany URL.
    imageUrl: row.imageUrl ?? '',
    isActive: row.isActive,
    mealType: row.mealType,
    prepTimeMinutes: row.prepTimeMinutes,
    kcalPerServing: kcalPerServing(row.nutritionKcal, row.servings),
    inPlans,
    favorites,
  };
}
