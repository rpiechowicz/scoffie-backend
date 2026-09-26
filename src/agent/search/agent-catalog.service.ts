import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { DietPreferenceValue, MealType } from '@prisma/client';
import { AppException } from '../../common/app-exception';
import { PrismaService } from '../../prisma/prisma.service';
import { parseWeekStart } from '../../weekly-plans/utils/week-formatting.util';
import { buildCatalogDigest, CatalogDigest } from '../catalog-digest';
import {
  buildCatalogMap,
  RecipeHit,
  RecipeSearchQuery,
  RecipeSearchResult,
  SearchableRecipe,
  SearchAudience,
  SearchSignals,
  SearchSourceRecipe,
  searchRecipes,
  toSearchable,
} from './catalog-search';

/**
 * Gospodarstwo katalogowe — to samo, co `RECIPE_IMPORT_HOUSEHOLD_ID`.
 * Czytane z env, bo na dev i na produkcji ma inne id.
 */
const DEFAULT_CATALOG_HOUSEHOLD = '22222222-2222-4222-8222-222222222222';

export function catalogHouseholdId(): string {
  return (
    (process.env.RECIPE_IMPORT_HOUSEHOLD_ID ?? '').trim() ||
    DEFAULT_CATALOG_HOUSEHOLD
  );
}

/**
 * Indeks katalogu żyje najwyżej tyle, nawet gdy odcisk się nie zmienił.
 * Odcisk (liczba przepisów + ostatnie zmiany przepisów i ich składników) nie
 * widzi zmiany samego SKŁADNIKA (gramatura sztuki, dział) — rzadkiej, ale
 * możliwej z panelu. Dziesięć minut to górna granica tej nieświeżości.
 */
const SNAPSHOT_MAX_AGE_MS = 10 * 60 * 1000;
/** Popularność zmienia się powoli — liczona raz na pół godziny. */
const POPULARITY_MAX_AGE_MS = 30 * 60 * 1000;

export type CatalogSnapshot = {
  /** Digest (linie przepisów) i indeks `R007` → `recipeId` tej wersji katalogu. */
  digest: CatalogDigest;
  /** Mapa katalogu do promptu — stały rozmiar, patrz `buildCatalogMap`. */
  map: string;
  /** Dokumenty wyszukiwania katalogu w kolejności indeksu. */
  recipes: SearchableRecipe[];
  byId: Map<string, SearchableRecipe>;
};

export type SearchContext = {
  userId: string;
  householdId: string;
  /** Planowany tydzień (poniedziałek `YYYY-MM-DD`); brak = bez sygnałów planu. */
  weekStart?: string;
  /** Jedzący; puste = cały dom. */
  forUserIds: string[];
  /** Domownicy ze zgodą na asystenta — tylko ich ograniczenia mają imiona w wyniku. */
  consentedUserIds: ReadonlySet<string>;
};

/** Trafienie z identyfikatorem — executor zamienia go na referencję tury. */
export type RecipeHitWithId = RecipeHit & { id: string };

export type AgentSearchResult = Omit<RecipeSearchResult, 'hits'> & {
  hits: RecipeHitWithId[];
  /** Twarde ograniczenia, które nałożył serwer — po ludzku, do zacytowania. */
  appliedForAudience: string[];
};

type RecipeRow = SearchSourceRecipe & {
  ingredients: (SearchSourceRecipe['ingredients'][number] & {
    ingredient?: { gramsPerPiece: number | null };
  })[];
};

const RECIPE_SELECT = {
  id: true,
  title: true,
  description: true,
  mealType: true,
  suitableMealTypes: true,
  prepTimeMinutes: true,
  servings: true,
  nutritionKcal: true,
  nutritionProtein: true,
  nutritionFat: true,
  nutritionCarbs: true,
  allergens: true,
  dietTags: true,
  ingredients: {
    select: {
      ingredientId: true,
      name: true,
      department: true,
      normalizedAmount: true,
      normalizedUnit: true,
      ingredient: { select: { gramsPerPiece: true } },
    },
  },
} as const;

type LoadedRow = {
  id: string;
  title: string;
  description?: string | null;
  mealType: MealType;
  suitableMealTypes: MealType[];
  prepTimeMinutes: number;
  servings: number;
  nutritionKcal: number;
  nutritionProtein: number;
  nutritionFat: number;
  nutritionCarbs: number;
  allergens: string[];
  dietTags: string[];
  ingredients: {
    ingredientId?: string;
    name: string;
    department?: string;
    normalizedAmount: number;
    normalizedUnit: string;
    ingredient?: { gramsPerPiece: number | null } | null;
  }[];
};

function toSource(row: LoadedRow): RecipeRow {
  return {
    ...row,
    ingredients: row.ingredients.map((item) => ({
      ingredientId: item.ingredientId ?? '',
      name: item.name,
      department: item.department ?? '',
      normalizedAmount: item.normalizedAmount,
      normalizedUnit: item.normalizedUnit,
      gramsPerPiece: item.ingredient?.gramsPerPiece ?? null,
    })),
  };
}

const DIET_LABELS: Record<DietPreferenceValue, string> = {
  NONE: '',
  VEGETARIAN: 'wegetariańska',
  VEGAN: 'wegańska',
  PESCATARIAN: 'peskatariańska',
  KETO: 'keto',
  PALEO: 'paleo',
  HIGH_PROTEIN: 'wysokobiałkowa',
};

/**
 * Katalog dla asystenta: indeks w pamięci + wyszukiwanie.
 *
 * Do 24.09.2026 katalog budował się od nowa przy KAŻDEJ turze (zapytanie
 * o 500 przepisów ze składnikami) i jechał cały w prompcie. Teraz buduje się
 * raz na wersję katalogu i żyje w pamięci procesu (jedna instancja Railway),
 * a do modelu idą wyniki wyszukiwania, nie katalog.
 *
 * Wersję poznajemy po tanim odcisku (liczba przepisów + najpóźniejsza zmiana
 * przepisu i jego składników), sprawdzanym przy każdej turze. Katalog zmienia
 * się rzadko (import, panel), więc prawie zawsze to jedno zapytanie
 * agregujące zamiast pięciuset wierszy.
 */
@Injectable()
export class AgentCatalogService {
  private readonly logger = new Logger(AgentCatalogService.name);
  private cached: {
    key: string;
    at: number;
    snapshot: CatalogSnapshot;
  } | null = null;
  private building: Promise<CatalogSnapshot> | null = null;
  private popularity: { at: number; counts: Map<string, number> } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** Aktualny indeks katalogu — z pamięci, gdy katalog się nie zmienił. */
  async snapshot(): Promise<CatalogSnapshot> {
    const householdId = catalogHouseholdId();
    const key = await this.versionKey(householdId);
    const now = Date.now();
    if (
      key !== null &&
      this.cached &&
      this.cached.key === key &&
      now - this.cached.at < SNAPSHOT_MAX_AGE_MS
    ) {
      return this.cached.snapshot;
    }
    // Jedna budowa naraz: dwie tury startujące po zmianie katalogu czekają
    // na tę samą, zamiast czytać 500 przepisów dwa razy.
    this.building ??= this.build(householdId).finally(() => {
      this.building = null;
    });
    const snapshot = await this.building;
    if (key !== null) this.cached = { key, at: now, snapshot };
    return snapshot;
  }

  /**
   * Odcisk wersji katalogu; `null` = nie da się go policzyć (wtedy bez
   * pamięci, budowa przy każdej turze — dokładnie jak przed zmianą).
   */
  private async versionKey(householdId: string): Promise<string | null> {
    try {
      const [recipes, ingredients] = await Promise.all([
        this.prisma.recipe.aggregate({
          where: { householdId, isCatalog: true },
          _count: { _all: true },
          _max: { updatedAt: true },
        }),
        this.prisma.recipeIngredient.aggregate({
          where: { recipe: { householdId, isCatalog: true } },
          _max: { updatedAt: true },
        }),
      ]);
      return [
        recipes._count._all,
        recipes._max.updatedAt?.toISOString() ?? '-',
        ingredients._max.updatedAt?.toISOString() ?? '-',
      ].join('|');
    } catch {
      return null;
    }
  }

  private async build(householdId: string): Promise<CatalogSnapshot> {
    // Ta sama kolejność co `loadDigestRecipes` (tytuł, id) — numeracja
    // `R007` musi być identyczna niezależnie od tego, kto ją liczy.
    // `isCatalog: true` JAWNIE, nie sam właściciel: prywatny przepis konta
    // katalogowego (`isCatalog: false`) nie jest katalogiem i nie ma prawa
    // dostać numeru `R…` ani wyjść w wyszukiwarce obcemu domowi.
    const rows = (await this.prisma.recipe.findMany({
      where: { householdId, isCatalog: true, isActive: true },
      orderBy: [{ title: 'asc' }, { id: 'asc' }],
      select: RECIPE_SELECT,
    })) as unknown as LoadedRow[];
    const sources = rows.map(toSource);
    const digest = buildCatalogDigest(
      sources.map((row) => ({
        ...row,
        ingredients: row.ingredients.map((item) => ({
          name: item.name,
          normalizedAmount: item.normalizedAmount,
          normalizedUnit: item.normalizedUnit,
          gramsPerPiece: item.gramsPerPiece,
        })),
      })),
    );
    const refById = new Map(
      Object.entries(digest.index).map(([ref, id]) => [id, ref]),
    );
    const recipes = sources.map((row) =>
      toSearchable(row, refById.get(row.id) ?? row.id, false),
    );
    const width = Math.max(2, String(recipes.length).length);
    return {
      digest,
      map: buildCatalogMap(recipes, width),
      recipes,
      byId: new Map(recipes.map((recipe) => [recipe.id, recipe])),
    };
  }

  /** Aktywne przepisy WŁASNE domu — zawsze świeże (jest ich kilka, nie setki). */
  private async householdRecipes(
    householdId: string,
  ): Promise<SearchableRecipe[]> {
    const rows = (await this.prisma.recipe.findMany({
      where: { householdId, isActive: true, isCatalog: false },
      orderBy: [{ title: 'asc' }, { id: 'asc' }],
      select: RECIPE_SELECT,
    })) as unknown as LoadedRow[];
    return rows.map((row) => toSearchable(toSource(row), row.id, true));
  }

  /**
   * Szukanie dla tury asystenta: filtry twarde jedzących, kryteria z prośby,
   * ranking z sygnałami domu.
   */
  async search(
    context: SearchContext,
    query: RecipeSearchQuery,
  ): Promise<AgentSearchResult> {
    const snapshot = await this.snapshot();
    const [own, { audience, applied }, signals] = await Promise.all([
      // Także dla konta katalogowego: jego prywatne przepisy nie są w
      // indeksie, więc przychodzą tędy — jako własne, z id zamiast `R…`.
      this.householdRecipes(context.householdId),
      this.audience(context),
      this.signals(context, snapshot),
    ]);
    const pool = [...snapshot.recipes, ...own];
    const result = searchRecipes(pool, query, audience, signals);
    const idByRef = new Map(pool.map((recipe) => [recipe.ref, recipe.id]));
    return {
      ...result,
      hits: result.hits.map((hit) => ({
        ...hit,
        id: idByRef.get(hit.recipe) ?? hit.recipe,
      })),
      appliedForAudience: applied,
    };
  }

  /**
   * Ograniczenia jedzących — WSZYSTKICH, także tych bez zgody na asystenta:
   * ich alergeny i tak pilnuje walidator przy zapisie, więc wyszukiwarka,
   * która by je pomijała, podsuwałaby dania skazane na odmowę. Imiona i
   * szczegóły idą do modelu tylko przy osobach ze zgodą.
   */
  private async audience(context: SearchContext): Promise<{
    audience: SearchAudience;
    applied: string[];
  }> {
    const rows = await this.prisma.membership.findMany({
      where: { householdId: context.householdId },
      select: {
        userId: true,
        user: {
          select: {
            displayName: true,
            preferences: {
              select: {
                allergens: true,
                excludedIngredientIds: true,
                dietPreference: true,
              },
            },
          },
        },
      },
    });
    const memberIds = new Set(rows.map((row) => row.userId));
    const unknown = context.forUserIds.filter((id) => !memberIds.has(id));
    if (unknown.length > 0) {
      throw new AppException(
        'VALIDATION_ERROR',
        'for_user_ids: to nie są domownicy tego gospodarstwa. Weź identyfikatory z get_household_context albo zostaw listę pustą (cały dom).',
        HttpStatus.BAD_REQUEST,
        unknown,
      );
    }
    const eaters =
      context.forUserIds.length > 0
        ? rows.filter((row) => context.forUserIds.includes(row.userId))
        : rows;

    const allergens = new Set<string>();
    const excluded = new Set<string>();
    const diets = new Set<DietPreferenceValue>();
    const applied: string[] = [];
    let withheld = 0;
    for (const row of eaters) {
      const prefs = row.user.preferences;
      const own = {
        allergens: prefs?.allergens ?? [],
        excluded: prefs?.excludedIngredientIds ?? [],
        diet: prefs?.dietPreference ?? 'NONE',
      };
      own.allergens.forEach((id) => allergens.add(id));
      own.excluded.forEach((id) => excluded.add(id));
      if (own.diet !== 'NONE') diets.add(own.diet);
      const restricted =
        own.allergens.length > 0 ||
        own.excluded.length > 0 ||
        own.diet !== 'NONE';
      if (!restricted) continue;
      if (!context.consentedUserIds.has(row.userId)) {
        withheld += 1;
        continue;
      }
      const parts = [
        ...(own.diet !== 'NONE' ? [`dieta ${DIET_LABELS[own.diet]}`] : []),
        ...(own.allergens.length > 0
          ? [`bez: ${[...own.allergens].sort().join(', ')}`]
          : []),
        ...(own.excluded.length > 0
          ? [`${own.excluded.length} wykluczonych składników`]
          : []),
      ];
      applied.push(`${row.user.displayName}: ${parts.join('; ')}`);
    }
    if (withheld > 0) {
      applied.push(
        `ograniczenia ${withheld} domowników bez zgody na asystenta (nałożone, bez szczegółów)`,
      );
    }
    return {
      audience: {
        allergens: [...allergens].sort(),
        excludedIngredientIds: [...excluded].sort(),
        diets: [...diets].sort(),
      },
      applied,
    };
  }

  /**
   * Sygnały rankingu. Każdy best-effort: brak planu albo błąd odczytu to
   * ranking bez tego sygnału, nigdy nieudane wyszukiwanie.
   */
  private async signals(
    context: SearchContext,
    snapshot: CatalogSnapshot,
  ): Promise<SearchSignals> {
    const [planned, favorites, popularity] = await Promise.all([
      this.plannedRecipes(context).catch(() => ({
        thisWeek: new Set<string>(),
        lastWeek: new Set<string>(),
      })),
      this.prisma.recipeFavorite
        .findMany({
          where: { householdId: context.householdId },
          select: { recipeId: true },
        })
        .then((rows) => new Set(rows.map((row) => row.recipeId)))
        .catch(() => new Set<string>()),
      this.popularityCounts(),
    ]);
    const weekIngredientIds = new Set<string>();
    for (const recipeId of planned.thisWeek) {
      const recipe = snapshot.byId.get(recipeId);
      recipe?.ingredients
        .filter((ingredient) => !ingredient.pantry)
        .forEach((ingredient) => weekIngredientIds.add(ingredient.id));
    }
    return {
      plannedThisWeek: planned.thisWeek,
      plannedLastWeek: planned.lastWeek,
      favorites,
      weekIngredientIds,
      popularity,
    };
  }

  private async plannedRecipes(
    context: SearchContext,
  ): Promise<{ thisWeek: Set<string>; lastWeek: Set<string> }> {
    const thisWeek = new Set<string>();
    const lastWeek = new Set<string>();
    if (!context.weekStart) return { thisWeek, lastWeek };
    const start = parseWeekStart(context.weekStart);
    const previous = new Date(start.getTime() - 7 * 24 * 60 * 60 * 1000);
    const items = await this.prisma.planItem.findMany({
      where: {
        weeklyPlan: {
          householdId: context.householdId,
          weekStart: { in: [start, previous] },
        },
      },
      select: { recipeId: true, weeklyPlan: { select: { weekStart: true } } },
    });
    for (const item of items) {
      if (item.weeklyPlan.weekStart.getTime() === start.getTime()) {
        thisWeek.add(item.recipeId);
      } else {
        lastWeek.add(item.recipeId);
      }
    }
    return { thisWeek, lastWeek };
  }

  /** Ile razy przepis stał w planach WSZYSTKICH domów — pamięć na pół godziny. */
  private async popularityCounts(): Promise<Map<string, number>> {
    const now = Date.now();
    if (this.popularity && now - this.popularity.at < POPULARITY_MAX_AGE_MS) {
      return this.popularity.counts;
    }
    try {
      const rows = await this.prisma.planItem.groupBy({
        by: ['recipeId'],
        _count: { _all: true },
      });
      const counts = new Map(
        rows.map((row) => [row.recipeId, row._count._all]),
      );
      this.popularity = { at: now, counts };
      return counts;
    } catch (error) {
      this.logger.warn(
        `popularność przepisów niedostępna (${
          error instanceof Error ? error.name : 'nieznany błąd'
        }) — ranking bez niej`,
      );
      return this.popularity?.counts ?? new Map();
    }
  }
}
