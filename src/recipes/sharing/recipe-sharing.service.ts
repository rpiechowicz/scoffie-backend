import { Injectable, Logger } from '@nestjs/common';
import {
  Difficulty,
  MealType,
  Prisma,
  RecipeShareEventKind,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { assertUuid, isUuid } from '../../common/uuid';
import { RecipesService } from '../recipes.service';
import { RecipesCacheService } from '../recipes-cache.service';
import { stepsFromInstructions } from '../recipe-steps.util';
import { isCookidooIntegrationEnabled } from '../../integrations/cookidoo-flag';
import {
  catalogRecipeUrl,
  generateRecipeShareToken,
  isRecipeShareToken,
  isRecipeSlug,
  recipeLinkNotFound,
  sharedRecipeUrl,
} from './recipe-share-links';

/** `recipes:shareLink` — adres do arkusza udostępniania. */
export type RecipeShareLink = {
  url: string;
  kind: 'CATALOG' | 'HOUSEHOLD';
  token: string | null;
  /** Link powstał TERAZ — gateway rozgłasza wtedy zmianę domownikom. */
  created: boolean;
};

export type RecipeLinkOrigin = 'CATALOG' | 'HOUSEHOLD' | 'SHARED';

/** Szczegóły przepisu — ten sam kształt co ack `recipes:findById`. */
type RecipeDetailAck = Awaited<ReturnType<RecipesService['toDetail']>>;

/**
 * `recipes:openShared` — JEDEN nazwany kształt (schemat w OpenAPI), nie suma
 * trzech wariantów: `recipe.householdId` jest `null` dla przepisu innego domu.
 */
export type OpenedRecipeLink = {
  origin: RecipeLinkOrigin;
  recipe: Omit<RecipeDetailAck, 'householdId'> & { householdId: string | null };
  /** SHARED: aktywna kopia, którą dom pytającego już zapisał. */
  savedRecipeId: string | null;
  /** Token linku, gdy otwarto po tokenie. */
  shareToken: string | null;
};

/** Przepis dla strony (`GET /public/recipes/…`) — bez autora, domu i kroków. */
export type PublicRecipe = {
  kind: 'CATALOG' | 'SHARED';
  /** Kanoniczny slug katalogu — strona robi 301, gdy adres był inny. */
  slug: string | null;
  title: string;
  description: string | null;
  imageUrl: string;
  mealType: MealType;
  difficulty: Difficulty;
  prepTimeMinutes: number;
  servings: number;
  perServing: { kcal: number; protein: number; fat: number; carbs: number };
  allergens: string[];
  ingredients: { name: string; amount: number; unit: string }[];
  stepCount: number;
  thermomix: boolean;
};

/** Kolejność składników przepisu = `[createdAt, id]` (zob. CLAUDE.md). */
const ingredientOrder: Prisma.RecipeIngredientOrderByWithRelationInput[] = [
  { createdAt: 'asc' },
  { id: 'asc' },
];

const publicSelect = {
  id: true,
  slug: true,
  title: true,
  description: true,
  imageUrl: true,
  sourceMeta: true,
  mealType: true,
  difficulty: true,
  prepTimeMinutes: true,
  servings: true,
  nutritionKcal: true,
  nutritionProtein: true,
  nutritionFat: true,
  nutritionCarbs: true,
  allergens: true,
  sourceInstructions: true,
  sourceProvider: true,
  sourceRecipeId: true,
  ingredients: {
    orderBy: ingredientOrder,
    select: { name: true, amount: true, unit: true },
  },
} as const;

type PublicRecipeRow = Prisma.RecipeGetPayload<{ select: typeof publicSelect }>;

/** Kolumny przepisu przenoszone do kopii „Zapisz u siebie”. */
const copySelect = {
  id: true,
  title: true,
  description: true,
  imageUrl: true,
  sourceMeta: true,
  sourceProvider: true,
  sourceRecipeId: true,
  sourceInstructions: true,
  mealType: true,
  suitableMealTypes: true,
  difficulty: true,
  prepTimeMinutes: true,
  servings: true,
  nutritionKcal: true,
  nutritionProtein: true,
  nutritionFat: true,
  nutritionCarbs: true,
  nutritionFiber: true,
  nutritionSalt: true,
  nutritionSaltAdded: true,
  nutritionSugars: true,
  nutritionSaturatedFat: true,
  allergens: true,
  dietTags: true,
  cuisine: true,
  dishType: true,
  seasons: true,
  occasions: true,
  equipment: true,
  features: true,
  ingredients: {
    orderBy: ingredientOrder,
    select: {
      ingredientId: true,
      name: true,
      amount: true,
      unit: true,
      normalizedAmount: true,
      normalizedUnit: true,
      department: true,
    },
  },
} as const;

/**
 * Udostępnianie przepisów linkiem (29.09.2026) — kontrakt w
 * `docs/plans/udostepnianie-przepisow/KONTRAKT.md`.
 *
 * Katalog udostępnia się stałym adresem ze slugiem (nic nie zapisujemy),
 * przepis gospodarstwa — tokenem z `RecipeShare`. Każda droga, która nie
 * prowadzi do aktywnego przepisu, kończy się TYM SAMYM 404
 * (`recipeLinkNotFound`), również w publicznym API strony.
 */
@Injectable()
export class RecipeSharingService {
  private readonly logger = new Logger(RecipeSharingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly recipes: RecipesService,
    private readonly recipesCache: RecipesCacheService,
  ) {}

  /**
   * Adres do udostępnienia: katalog → slug, przepis TEGO domu → aktywny link
   * (tworzony przy pierwszym razie). Cudzy przepis → 404, jak w `findById`.
   */
  async shareLink(
    userIdentifier: string,
    householdId: string,
    recipeId: string,
  ): Promise<RecipeShareLink> {
    assertUuid(recipeId, 'recipeId');
    await this.recipes.ensureMembership(userIdentifier, householdId);
    const recipe = await this.prisma.recipe.findFirst({
      where: { id: recipeId, isActive: true },
      select: { id: true, isCatalog: true, householdId: true, slug: true },
    });
    if (!recipe) throw recipeLinkNotFound();
    if (recipe.isCatalog) {
      // Trigger nadaje slug każdemu przepisowi katalogu; brak = baza sprzed
      // migracji albo ręczna ingerencja — lepiej 404 niż link do niczego.
      if (!recipe.slug) throw recipeLinkNotFound();
      return {
        url: catalogRecipeUrl(recipe.slug),
        kind: 'CATALOG',
        token: null,
        created: false,
      };
    }
    if (recipe.householdId !== householdId) throw recipeLinkNotFound();

    const userId = await this.recipes.resolveUserId(userIdentifier);
    const { token, created } = await this.activeShare(
      recipeId,
      householdId,
      userId,
    );
    return { url: sharedRecipeUrl(token), kind: 'HOUSEHOLD', token, created };
  }

  /**
   * Aktywny link (przepis, dom) albo nowy. Wyścig dwóch pierwszych kliknięć
   * rozstrzyga częściowy indeks `RecipeShare_active_key`: przegrany dostaje
   * P2002 i czyta wiersz zwycięzcy — oba telefony pokażą ten sam adres.
   */
  private async activeShare(
    recipeId: string,
    householdId: string,
    userId: string,
  ): Promise<{ token: string; created: boolean }> {
    const existing = await this.prisma.recipeShare.findFirst({
      where: { recipeId, householdId, revokedAt: null },
      select: { token: true },
    });
    if (existing) return { token: existing.token, created: false };
    try {
      const share = await this.prisma.recipeShare.create({
        data: {
          token: generateRecipeShareToken(),
          recipeId,
          householdId,
          createdById: userId,
        },
        select: { token: true },
      });
      return { token: share.token, created: true };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const winner = await this.prisma.recipeShare.findFirst({
          where: { recipeId, householdId, revokedAt: null },
          select: { token: true },
        });
        if (winner) return { token: winner.token, created: false };
      }
      throw error;
    }
  }

  /** „Wyłącz link” — dowolny domownik; `false`, gdy nie było czego wyłączać. */
  async revokeShare(
    userIdentifier: string,
    householdId: string,
    recipeId: string,
  ): Promise<{ revoked: boolean }> {
    assertUuid(recipeId, 'recipeId');
    await this.recipes.ensureMembership(userIdentifier, householdId);
    const result = await this.prisma.recipeShare.updateMany({
      where: { recipeId, householdId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { revoked: result.count > 0 };
  }

  /**
   * Zgłoszenie z aplikacji: arkusz udostępniania zakończył się wysłaniem.
   * Ta sama bramka widoczności co odczyt — licznik nie przyjmie przepisu,
   * którego pytający nie widzi.
   */
  async recordShared(
    userIdentifier: string,
    householdId: string,
    recipeId: string,
  ): Promise<{ ok: true }> {
    assertUuid(recipeId, 'recipeId');
    await this.recipes.ensureMembership(userIdentifier, householdId);
    const recipe = await this.prisma.recipe.findFirst({
      where: {
        id: recipeId,
        isActive: true,
        OR: [{ isCatalog: true }, { householdId }],
      },
      select: { id: true },
    });
    if (!recipe) throw recipeLinkNotFound();
    await this.recordEvent(recipe.id, 'SHARED');
    return { ok: true };
  }

  /**
   * Otwarcie linku w aplikacji. `HOUSEHOLD` = token wskazuje przepis domu
   * pytającego (zwykły szczegół), `SHARED` = przepis innego domu, tylko do
   * odczytu — bez cudzego `householdId` i bez ulubionego.
   */
  async openShared(
    userIdentifier: string,
    householdId: string,
    link: { slug?: string; token?: string },
  ): Promise<OpenedRecipeLink> {
    await this.recipes.ensureMembership(userIdentifier, householdId);
    const hasSlug = link.slug !== undefined;
    const hasToken = link.token !== undefined;
    if (hasSlug === hasToken) throw recipeLinkNotFound();

    if (hasSlug) {
      const recipeId = await this.catalogRecipeIdForLink(link.slug!);
      if (!recipeId) throw recipeLinkNotFound();
      const row = await this.prisma.recipe.findFirst({
        where: { id: recipeId, isActive: true, isCatalog: true },
        select: this.recipes.detailSelect,
      });
      if (!row) throw recipeLinkNotFound();
      await this.recordEvent(row.id, 'OPENED');
      return {
        origin: 'CATALOG',
        recipe: await this.recipes.toDetail(row, householdId),
        savedRecipeId: null,
        shareToken: null,
      };
    }

    const share = await this.activeShareByToken(link.token!);
    if (!share) throw recipeLinkNotFound();
    const row = await this.prisma.recipe.findFirst({
      where: { id: share.recipeId, isActive: true },
      select: this.recipes.detailSelect,
    });
    if (!row) throw recipeLinkNotFound();
    await this.recordEvent(row.id, 'OPENED');

    if (share.householdId === householdId) {
      return {
        origin: 'HOUSEHOLD',
        recipe: await this.recipes.toDetail(row, householdId),
        savedRecipeId: null,
        shareToken: link.token!,
      };
    }
    const saved = await this.savedCopyOf(row.id, householdId);
    const detail = await this.recipes.toDetail(row, null);
    return {
      origin: 'SHARED',
      // Cudzy dom nie wychodzi poza serwer — w kopii odbiorcy i tak będzie jego.
      recipe: { ...detail, householdId: null },
      savedRecipeId: saved?.id ?? null,
      shareToken: link.token!,
    };
  }

  /**
   * „Zapisz u siebie”: kopia przepisu z linku w domu pytającego.
   *
   * Idempotentna — drugi zapis oddaje istniejącą, AKTYWNĄ kopię. Wyścig
   * dwóch kliknięć (dwa telefony domu naraz) szereguje zamek doradczy
   * transakcji na parze (dom, źródło): drugi czeka, potem widzi kopię
   * pierwszego. Token przepisu tego samego domu → oryginał, bez kopii.
   */
  async saveShared(
    userIdentifier: string,
    householdId: string,
    token: string,
  ): Promise<{
    recipe: Awaited<ReturnType<RecipesService['toDetail']>>;
    created: boolean;
  }> {
    await this.recipes.ensureMembership(userIdentifier, householdId);
    const share = await this.activeShareByToken(token);
    if (!share) throw recipeLinkNotFound();
    const source = await this.prisma.recipe.findFirst({
      where: { id: share.recipeId, isActive: true },
      select: copySelect,
    });
    if (!source) throw recipeLinkNotFound();

    if (share.householdId === householdId) {
      return {
        recipe: await this.detailOf(source.id, householdId),
        created: false,
      };
    }

    const userId = await this.recipes.resolveUserId(userIdentifier);
    const { recipeId, created } = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`recipe-copy:${householdId}:${source.id}`}))`;
      const existing = await tx.recipe.findFirst({
        where: {
          copiedFromRecipeId: source.id,
          householdId,
          isActive: true,
        },
        select: { id: true },
      });
      if (existing) return { recipeId: existing.id, created: false };
      const copy = await tx.recipe.create({
        data: this.copyData(source, householdId, userId),
        select: { id: true },
      });
      return { recipeId: copy.id, created: true };
    });

    if (created) {
      this.recipesCache.invalidateRecipesList(householdId);
      await this.recordEvent(source.id, 'SAVED');
    }
    return { recipe: await this.detailOf(recipeId, householdId), created };
  }

  /** Dane przepisu dla strony po slugu (też UUID i stary slug). */
  async publicBySlug(slugOrId: string): Promise<PublicRecipe> {
    const recipeId = await this.catalogRecipeIdForLink(slugOrId);
    if (!recipeId) throw recipeLinkNotFound();
    const row = await this.prisma.recipe.findFirst({
      where: { id: recipeId, isActive: true, isCatalog: true },
      select: publicSelect,
    });
    if (!row) throw recipeLinkNotFound();
    return this.toPublic(row, 'CATALOG');
  }

  /** Dane przepisu dla strony po tokenie linku gospodarstwa. */
  async publicByToken(token: string): Promise<PublicRecipe> {
    const share = await this.activeShareByToken(token);
    if (!share) throw recipeLinkNotFound();
    const row = await this.prisma.recipe.findFirst({
      where: { id: share.recipeId, isActive: true },
      select: publicSelect,
    });
    if (!row) throw recipeLinkNotFound();
    return this.toPublic(row, 'SHARED');
  }

  /**
   * Adres katalogu → id przepisu: aktualny slug, stary slug (alias), a na
   * końcu UUID (link z samym id). Kształt sprawdzamy PRZED bazą — śmieci nie
   * kosztują zapytania.
   */
  private async catalogRecipeIdForLink(value: string): Promise<string | null> {
    if (isUuid(value)) return value.toLowerCase();
    if (!isRecipeSlug(value)) return null;
    const current = await this.prisma.recipe.findUnique({
      where: { slug: value },
      select: { id: true },
    });
    if (current) return current.id;
    const alias = await this.prisma.recipeSlugAlias.findUnique({
      where: { slug: value },
      select: { recipeId: true },
    });
    return alias?.recipeId ?? null;
  }

  private async activeShareByToken(token: string) {
    if (!isRecipeShareToken(token)) return null;
    return this.prisma.recipeShare.findFirst({
      where: { token, revokedAt: null },
      select: { recipeId: true, householdId: true },
    });
  }

  private savedCopyOf(sourceId: string, householdId: string) {
    return this.prisma.recipe.findFirst({
      where: { copiedFromRecipeId: sourceId, householdId, isActive: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
  }

  private async detailOf(recipeId: string, householdId: string) {
    const row = await this.prisma.recipe.findUniqueOrThrow({
      where: { id: recipeId },
      select: this.recipes.detailSelect,
    });
    return this.recipes.toDetail(row, householdId);
  }

  /**
   * Kolumny kopii. Zdjęcie idzie jako ROZWIĄZANY adres: przepis bez własnego
   * zdjęcia dostaje obrazek generowany z ziarnem po `id`, więc kopia z nowym
   * id pokazałaby inne danie niż to, które odbiorca zobaczył w linku.
   * Składniki z rosnącym `createdAt` — kolejność = `[createdAt, id]`.
   */
  private copyData(
    source: Prisma.RecipeGetPayload<{ select: typeof copySelect }>,
    householdId: string,
    authorId: string,
  ): Prisma.RecipeUncheckedCreateInput {
    const now = Date.now();
    return {
      title: source.title,
      description: source.description,
      imageUrl: this.recipes.resolveRecipeImageUrl(source),
      sourceMeta: source.sourceMeta ?? Prisma.JsonNull,
      sourceProvider: source.sourceProvider,
      sourceRecipeId: source.sourceRecipeId,
      sourceInstructions: source.sourceInstructions ?? Prisma.JsonNull,
      mealType: source.mealType,
      suitableMealTypes: source.suitableMealTypes,
      difficulty: source.difficulty,
      prepTimeMinutes: source.prepTimeMinutes,
      servings: source.servings,
      nutritionKcal: source.nutritionKcal,
      nutritionProtein: source.nutritionProtein,
      nutritionFat: source.nutritionFat,
      nutritionCarbs: source.nutritionCarbs,
      nutritionFiber: source.nutritionFiber,
      nutritionSalt: source.nutritionSalt,
      nutritionSaltAdded: source.nutritionSaltAdded,
      nutritionSugars: source.nutritionSugars,
      nutritionSaturatedFat: source.nutritionSaturatedFat,
      allergens: source.allergens,
      dietTags: source.dietTags,
      cuisine: source.cuisine,
      dishType: source.dishType,
      seasons: source.seasons,
      occasions: source.occasions,
      equipment: source.equipment,
      features: source.features,
      // Kopia jest przepisem TEGO domu — do katalogu nie trafia nigdy.
      isCatalog: false,
      householdId,
      authorId,
      copiedFromRecipeId: source.id,
      ingredients: source.ingredients.length
        ? {
            create: source.ingredients.map((row, index) => ({
              ...row,
              createdAt: new Date(now + index),
            })),
          }
        : undefined,
    };
  }

  private toPublic(
    row: PublicRecipeRow,
    kind: PublicRecipe['kind'],
  ): PublicRecipe {
    const servings = Math.max(1, row.servings);
    const perServing = (value: number, digits: number) =>
      Number((value / servings).toFixed(digits));
    return {
      kind,
      slug: kind === 'CATALOG' ? row.slug : null,
      title: row.title,
      description: row.description,
      imageUrl: this.recipes.resolveRecipeImageUrl(row),
      mealType: row.mealType,
      difficulty: row.difficulty,
      prepTimeMinutes: row.prepTimeMinutes,
      servings: row.servings,
      perServing: {
        kcal: Math.round(row.nutritionKcal / servings),
        protein: perServing(row.nutritionProtein, 1),
        fat: perServing(row.nutritionFat, 1),
        carbs: perServing(row.nutritionCarbs, 1),
      },
      allergens: row.allergens,
      ingredients: row.ingredients.map((ingredient) => ({
        name: ingredient.name,
        amount: ingredient.amount,
        unit: ingredient.unit,
      })),
      stepCount: stepsFromInstructions(row.sourceInstructions).length,
      // Pole zostaje w kontrakcie strony, ale bez zgody Vorwerka plakietka
      // „Thermomix” nie może wyjść na publiczną stronę przepisu — prawda
      // tylko przy włączonej integracji (6.10.2026).
      thermomix:
        isCookidooIntegrationEnabled() &&
        row.sourceProvider === 'cookidoo' &&
        Boolean(row.sourceRecipeId),
    };
  }

  /**
   * Licznik jest dodatkiem — jego awaria nie może zepsuć otwarcia przepisu
   * ani zapisu kopii, więc błąd tylko logujemy.
   */
  private async recordEvent(
    recipeId: string,
    kind: RecipeShareEventKind,
  ): Promise<void> {
    try {
      await this.prisma.recipeShareEvent.create({ data: { recipeId, kind } });
    } catch (error) {
      this.logger.warn(
        `Nie zapisano zdarzenia ${kind} dla przepisu ${recipeId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
