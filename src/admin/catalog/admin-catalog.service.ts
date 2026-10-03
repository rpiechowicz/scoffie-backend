import { HttpStatus, Injectable } from '@nestjs/common';
import { MealType, Prisma, RecipeShareEventKind } from '@prisma/client';
import { AppException } from '../../common/app-exception';
import { PrismaService } from '../../prisma/prisma.service';
import { RecipesCacheService } from '../../recipes/recipes-cache.service';
import { normalizeText } from '../../common/normalize-text.util';
import {
  nutritionColumnsFromIngredients,
  nutritionMissingDetails,
} from '../../recipes/recipe-nutrition.util';
import {
  catalogEntryFromColumns,
  catalogEntryFromRow,
  catalogExportSelect,
  changedCatalogFields,
  sameIngredientLines,
} from '../../recipes/catalog/catalog-export';
import {
  CatalogRecipeError,
  catalogRecipeColumns,
  ingredientCreateRows,
  loadCatalogIngredientLookup,
  resolveCatalogIngredients,
  validateCatalogRecipe,
  type CatalogIngredientRow,
  type CatalogRecipeInput,
} from '../../recipes/catalog/catalog-recipe';
import { canonicalTaxonomy } from '../../recipes/recipe-taxonomy';
import {
  AdminAuditService,
  type AdminActor,
} from '../audit/admin-audit.service';
import type {
  Ingredient,
  RecipeDetail,
  RecipeListItem,
  RecipeShareRevokeResult,
} from '../contract';
import {
  RECIPE_SHARE_TOKEN_PATTERN,
  isRecipeShareToken,
} from '../../recipes/sharing/recipe-share-links';
import { readOnlyQuery } from '../read-only-query';
import { inPlansByRecipe } from '../common/recipe-in-plans';
import {
  baseUnitFromUsage,
  comparePolish,
  stepsFromInstructions,
} from './catalog-math';
import { recipeFacetsSelect, toRecipeListFacets } from './recipe-list-facets';
import { recipeListSelect, toRecipeListItem } from './recipe-list-item';
import type { UpdateCatalogRecipeDto } from './admin-catalog.dto';

const recipeNotFound = () =>
  new AppException(
    'RECIPE_NOT_FOUND',
    'Nie znaleziono przepisu w katalogu.',
    HttpStatus.NOT_FOUND,
  );

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
        select: { ...recipeListSelect, ...recipeFacetsSelect },
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
        .map((row) => ({
          ...toRecipeListItem(
            row,
            plansOf.get(row.id) ?? 0,
            favoritesOf.get(row.id) ?? 0,
          ),
          facets: toRecipeListFacets(row),
        }))
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
          ...recipeListSelect,
          slug: true,
          description: true,
          sourceInstructions: true,
          dietTags: true,
          cuisine: true,
          dishType: true,
          seasons: true,
          occasions: true,
          equipment: true,
          features: true,
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
      const aliases = await tx.recipeSlugAlias.findMany({
        where: { recipeId: id },
        orderBy: [{ createdAt: 'desc' }, { slug: 'asc' }],
        select: { slug: true },
      });
      const events = await tx.recipeShareEvent.groupBy({
        by: ['kind'],
        where: { recipeId: id },
        _count: { _all: true },
      });
      const eventCount = (kind: RecipeShareEventKind) =>
        events.find((row) => row.kind === kind)?._count._all ?? 0;
      return {
        ...toRecipeListItem(recipe, inPlans, favorites),
        slug: recipe.slug,
        slugAliases: aliases.map((row) => row.slug),
        shares: {
          shared: eventCount('SHARED'),
          opened: eventCount('OPENED'),
          saved: eventCount('SAVED'),
        },
        description: recipe.description ?? '',
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
        dietTags: recipe.dietTags,
        ...canonicalTaxonomy(recipe),
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
          nutritionSugarsPer100: true,
          nutritionSaturatedFatPer100: true,
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
        .map((row): Ingredient => ({
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
          // „W tym cukry” / „w tym nasycone” — części `carbs` i `fat`.
          sugars: row.nutritionSugarsPer100 ?? 0,
          saturatedFat: row.nutritionSaturatedFatPer100 ?? 0,
          gramsPerPiece: row.gramsPerPiece,
          allergens: row.allergens,
          dietTags: row.dietTags,
        }))
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
   * A IMPORT KATALOGU? Od D1 (25.09.2026) plik katalogu jest eksportem bazy
   * i niesie `"isActive": false` dla wycofanych (nocny PR `catalog-sync`).
   * Import zapisuje `isActive` z pliku, ale na niepustym katalogu najpierw
   * liczy różnice i odmawia, gdy baza ma zmiany, których plik nie ma — więc
   * wycofanie nie zniknie po cichu przy imporcie starego pliku.
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

  /**
   * Edycja przepisu katalogu (D1, 25.09.2026: baza = źródło prawdy, plik JSON
   * = eksport, nocny PR z `catalog-sync`).
   *
   * Zapis idzie TĄ SAMĄ ścieżką co import (`src/recipes/catalog/`): wiersz →
   * wpis pliku (eksport) → poprawki z edytora → te same reguły poprawności,
   * normalizacja ilości, unia alergenów i tagów diet, sloty z klasyfikatorem.
   * Makro liczy serwer ze składników (`nutritionColumnsFromIngredients`) —
   * tylko gdy zmieniły się składniki; sól dodana zostaje z wiersza. Bez
   * zmiany składników makro zostaje, jakie było (katalog ma wartości z pliku,
   * przeliczone `recipes:recompute:nutrition`).
   *
   * Współbieżność optymistyczna: `updatedAt` z edytora musi się zgadzać
   * z wierszem pod blokadą (`FOR UPDATE`) — inaczej 409 `CONFLICT` i nic się
   * nie zapisuje. Brak zmian = brak zapisu (i `updatedAt` bez zmian).
   */
  async updateRecipe(
    actor: AdminActor,
    id: string,
    dto: UpdateCatalogRecipeDto,
  ): Promise<RecipeDetail> {
    if (dto.id !== undefined && dto.id !== id) {
      throw new AppException(
        'VALIDATION_ERROR',
        'Identyfikator w ciele nie zgadza się z adresem.',
        HttpStatus.BAD_REQUEST,
        ['id'],
      );
    }
    await this.audit.run(
      actor,
      { action: 'recipe.update', targetType: 'Recipe', targetId: id },
      () =>
        this.prisma.$transaction(async (tx) => {
          const locked = await tx.$queryRaw<{ updatedAt: Date }[]>(Prisma.sql`
            SELECT "updatedAt" FROM "Recipe"
            WHERE "id" = ${id}::uuid AND "isCatalog" = true
            FOR UPDATE
          `);
          if (locked.length === 0) throw recipeNotFound();
          const current = locked[0].updatedAt;
          if (current.getTime() !== Date.parse(dto.updatedAt)) {
            throw new AppException(
              'CONFLICT',
              'Ktoś zmienił ten przepis w międzyczasie — odśwież i nanieś zmiany jeszcze raz.',
              HttpStatus.CONFLICT,
              [`updatedAt: ${current.toISOString()}`],
            );
          }

          const row = await tx.recipe.findUniqueOrThrow({
            where: { id },
            select: catalogExportSelect,
          });
          if (
            dto.imageUrl !== undefined &&
            dto.imageUrl !== (row.imageUrl ?? '')
          ) {
            throw new AppException(
              'VALIDATION_ERROR',
              'Zmiana zdjęcia z panelu jeszcze nie działa (upload do R2 to osobny krok).',
              HttpStatus.BAD_REQUEST,
              ['imageUrl'],
            );
          }

          const before = catalogEntryFromRow(row);
          const lookup = await loadCatalogIngredientLookup(tx);
          const draft: CatalogRecipeInput = {
            ...before,
            title: dto.title.trim(),
            description: dto.description.trim(),
            mealType: dto.mealType as MealType,
            suitableMealTypes: dto.suitableMealTypes as MealType[],
            difficulty: dto.difficulty,
            prepTimeMinutes: dto.prepTimeMinutes,
            servings: dto.servings,
            // Taksonomia: panel sprzed katalogu 1000 jej nie wysyła —
            // pominięte pole zostaje takie, jakie było w bazie.
            ...(dto.cuisine !== undefined ? { cuisine: dto.cuisine } : {}),
            ...(dto.dishType !== undefined ? { dishType: dto.dishType } : {}),
            ...(dto.seasons !== undefined ? { seasons: dto.seasons } : {}),
            ...(dto.occasions !== undefined
              ? { occasions: dto.occasions }
              : {}),
            ...(dto.equipment !== undefined
              ? { equipment: dto.equipment }
              : {}),
            ...(dto.features !== undefined ? { features: dto.features } : {}),
            steps: dto.steps.map((text, index) => ({
              step: index + 1,
              instruction: text.trim(),
            })),
            // `key` = `normalizedName`; nieznany zostaje kluczem i wraca
            // w `details` jako „nieznany składnik: <key>”.
            ingredients: dto.ingredients.map((line) => ({
              ingredientName:
                lookup.get(normalizeText(line.key))?.name ?? line.key,
              amount: line.amount,
              unit: line.unit,
            })),
          };

          const problems = validateCatalogRecipe(draft);
          if (problems.length > 0) {
            throw new AppException(
              'VALIDATION_ERROR',
              'Przepis nie przechodzi reguł katalogu.',
              HttpStatus.BAD_REQUEST,
              problems,
            );
          }
          let rows: CatalogIngredientRow[];
          try {
            rows = resolveCatalogIngredients(draft, lookup);
          } catch (error) {
            if (error instanceof CatalogRecipeError) {
              throw new AppException(
                'VALIDATION_ERROR',
                'Złe składniki przepisu.',
                HttpStatus.BAD_REQUEST,
                error.details,
              );
            }
            throw error;
          }

          const recomputed = !sameIngredientLines(
            before.ingredients,
            draft.ingredients,
            { ignoreOrder: true },
          );
          if (recomputed) {
            const nutrition = nutritionColumnsFromIngredients(
              rows,
              before.nutrition.addedSalt ?? 0,
            );
            if (!nutrition.ok) {
              throw new AppException(
                'VALIDATION_ERROR',
                'Nie da się policzyć makro ze składników.',
                HttpStatus.BAD_REQUEST,
                nutritionMissingDetails(nutrition),
              );
            }
            draft.nutrition = {
              kcal: nutrition.columns.nutritionKcal,
              protein: nutrition.columns.nutritionProtein,
              carbs: nutrition.columns.nutritionCarbs,
              sugars: nutrition.columns.nutritionSugars,
              fat: nutrition.columns.nutritionFat,
              saturatedFat: nutrition.columns.nutritionSaturatedFat,
              fiber: nutrition.columns.nutritionFiber,
              salt: nutrition.columns.nutritionSalt,
              addedSalt: nutrition.columns.nutritionSaltAdded,
            };
          }

          const columns = catalogRecipeColumns(draft, rows);
          const after = catalogEntryFromColumns(
            id,
            columns,
            rows,
            row.imageUrl,
          );
          const changed: string[] = changedCatalogFields(before, after);
          const slug = await this.nextSlug(tx, id, dto.slug);
          if (changed.length > 0) {
            const rewriteIngredients = !sameIngredientLines(
              before.ingredients,
              after.ingredients,
            );
            await tx.recipe.update({
              where: { id },
              data: {
                ...columns,
                ...(rewriteIngredients
                  ? {
                      ingredients: {
                        deleteMany: {},
                        create: ingredientCreateRows(rows),
                      },
                    }
                  : {}),
              },
            });
          }
          if (slug !== null) {
            // Trigger `recipe_assign_slug` przenosi stary adres do aliasów
            // (link dalej prowadzi do przepisu), a log katalogu wysyła nowy
            // adres do telefonów.
            await tx.recipe.update({ where: { id }, data: { slug } });
            changed.push('slug');
          }
          return { changed, recomputedNutrition: recomputed };
        }),
      // Same nazwy pól — bez treści przepisu.
      (result) => ({
        changed: result.changed,
        recomputedNutrition: result.recomputedNutrition,
      }),
    );
    // Cache listy żyje w pamięci procesu (`RecipesCacheService`) — bez tego
    // aplikacja widziałaby starą wersję do końca TTL (90 s).
    this.recipesCache.invalidateRecipesList();
    return this.recipe(id);
  }

  /**
   * Wyłączenie zgłoszonego linku do przepisu gospodarstwa. Przyjmuje token
   * albo cały adres (operator wkleja to, co dostał w zgłoszeniu). W dzienniku
   * zostaje id udostępnienia i tytuł — nie token, bo to wciąż byłby klucz do
   * odczytu, gdyby link kiedyś przywrócić.
   */
  async revokeShare(
    actor: AdminActor,
    link: string,
    reason: string,
  ): Promise<RecipeShareRevokeResult> {
    const token = shareTokenFromLink(link);
    const share = token
      ? await this.prisma.recipeShare.findUnique({
          where: { token },
          select: {
            id: true,
            revokedAt: true,
            recipe: { select: { title: true } },
          },
        })
      : null;
    return this.audit.run(
      actor,
      {
        action: 'recipe.share.revoke',
        targetType: 'RecipeShare',
        targetId: share?.id ?? null,
        reason,
      },
      async () => {
        if (!share) return { revoked: false, recipeTitle: null };
        const result = await this.prisma.recipeShare.updateMany({
          where: { id: share.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        return { revoked: result.count > 0, recipeTitle: share.recipe.title };
      },
      (result) => ({ revoked: result.revoked }),
    );
  }

  /**
   * Nowy slug z edytora albo `null`, gdy nic się nie zmienia. Zajęty adres
   * (inny przepis albo cudzy stary adres) = 400 z polem `slug` — tę samą
   * regułę pilnuje trigger, ale komunikat z bazy nie nadaje się dla panelu.
   */
  private async nextSlug(
    tx: Prisma.TransactionClient,
    id: string,
    requested: string | undefined,
  ): Promise<string | null> {
    if (requested === undefined) return null;
    const current = await tx.recipe.findUniqueOrThrow({
      where: { id },
      select: { slug: true },
    });
    if (current.slug === requested) return null;
    const [takenByRecipe, takenByAlias] = await Promise.all([
      tx.recipe.findFirst({
        where: { slug: requested, id: { not: id } },
        select: { id: true },
      }),
      tx.recipeSlugAlias.findFirst({
        where: { slug: requested, recipeId: { not: id } },
        select: { recipeId: true },
      }),
    ]);
    if (takenByRecipe || takenByAlias) {
      throw new AppException(
        'VALIDATION_ERROR',
        'Ten adres ma już inny przepis (teraz albo wcześniej).',
        HttpStatus.BAD_REQUEST,
        ['slug'],
      );
    }
    return requested;
  }
}

/** Token z wklejonego linku (`…/przepis/u/<token>`) albo sam token. */
function shareTokenFromLink(link: string): string | null {
  const trimmed = link.trim();
  if (isRecipeShareToken(trimmed)) return trimmed;
  const match = new RegExp(
    `/przepis/u/(${RECIPE_SHARE_TOKEN_PATTERN.source.slice(1, -1)})/?(?:[?#].*)?$`,
  ).exec(trimmed);
  return match?.[1] ?? null;
}
