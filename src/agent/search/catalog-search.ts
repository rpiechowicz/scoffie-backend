import { DietPreferenceValue, MealType } from '@prisma/client';
import { normalizeText } from '../../common/normalize-text.util';
import {
  conflictingAllergens,
  satisfiesDiet,
} from '../../recipes/diet-rules.util';
import {
  RECIPE_SEARCH_TAGS,
  RECIPE_TAG_LABELS,
  RecipeSearchTag,
  RecipeTagGroup,
  recipeSearchTags,
  tagGroup,
} from '../../recipes/recipe-facets.util';
import { DIGEST_INGREDIENT_LIMIT } from '../catalog-digest';

/**
 * Wyszukiwarka przepisów asystenta — czyste funkcje, bez bazy.
 *
 * Model NIE przegląda katalogu. Tłumaczy prośbę człowieka na kryteria
 * (`find_recipes`), a to, co pasuje, wybiera ten kod — w dwóch etapach, jak
 * każdy duży silnik rekomendacji:
 *
 * 1. **Filtry twarde.** Alergeny, wykluczenia i dieta jedzących — tymi samymi
 *    funkcjami, którymi pilnuje zapisu walidator planu (`diet-rules.util`).
 *    Wyszukiwarka nie ma więc jak oddać dania, którego walidator by nie
 *    przepuścił. Potem kryteria z prośby: pora, tagi, składniki, czas, kalorie.
 * 2. **Ranking.** Trafność tekstu, a do tego sygnały, których model z listy
 *    500 linii rzetelnie nie policzy: danie już stoi w planie tego tygodnia,
 *    było w zeszłym, jest ulubione domu, dzieli składniki z tym, co i tak
 *    będzie kupione, jest popularne. Na końcu dywersyfikacja: nie pięć zup.
 *
 * Katalog 10 tys. przepisów to kilkadziesiąt MB w pamięci i ułamek sekundy
 * przejścia — bottleneckiem były TOKENY (cały katalog w prompcie), nie baza.
 */

export type SearchIngredient = {
  id: string;
  name: string;
  department: string;
  /** Masa porównawcza (g albo ml; `szt` przez `gramsPerPiece`) — do „głównych składników". */
  grams: number;
  /** Przyprawy i sosy nie liczą się do „składników wspólnych z planem". */
  pantry: boolean;
};

export type SearchPerServing = {
  kcal: number;
  protein: number;
  fat: number;
  carbs: number;
};

export type SearchableRecipe = {
  id: string;
  /** Referencja dla modelu: indeks katalogu (`R007`) albo UUID przepisu domu. */
  ref: string;
  title: string;
  mealType: MealType;
  /** `suitableMealTypes`, a pusta lista czytana jak `[mealType]`. */
  slots: MealType[];
  servings: number;
  prepTimeMinutes: number;
  /** `null` = przepis bez makr (diety makrowe go odrzucają, filtry kcal też). */
  perServing: SearchPerServing | null;
  allergens: string[];
  dietTags: string[];
  ingredients: SearchIngredient[];
  /** Pięć najcięższych składników — to samo, co w digeście. */
  mainIngredients: string[];
  tags: RecipeSearchTag[];
  /** Przepis gospodarstwa (nie z katalogu). */
  household: boolean;
  /** Słowa do dopasowania tekstu, już znormalizowane (bez polskich znaków). */
  words: {
    title: string[];
    tags: string[];
    ingredients: string[];
    description: string[];
  };
};

export type SearchSourceRecipe = {
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
    ingredientId: string;
    name: string;
    department: string;
    normalizedAmount: number;
    normalizedUnit: string;
    gramsPerPiece: number | null;
  }[];
};

const FALLBACK_GRAMS_PER_PIECE = 100;
/** Działy „z szafki" — ich składniki nie liczą się jako wspólne z planem. */
const PANTRY_DEPARTMENTS = ['przyprawy', 'olej'];

function words(text: string): string[] {
  return normalizeText(text)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

/** Buduje dokument wyszukiwania z wiersza bazy. Deterministycznie. */
export function toSearchable(
  recipe: SearchSourceRecipe,
  ref: string,
  household: boolean,
): SearchableRecipe {
  const servings = Math.max(1, recipe.servings);
  const hasNutrition =
    recipe.nutritionKcal > 0 ||
    recipe.nutritionProtein > 0 ||
    recipe.nutritionCarbs > 0 ||
    recipe.nutritionFat > 0;
  const perServing: SearchPerServing | null = hasNutrition
    ? {
        kcal: recipe.nutritionKcal / servings,
        protein: recipe.nutritionProtein / servings,
        fat: recipe.nutritionFat / servings,
        carbs: recipe.nutritionCarbs / servings,
      }
    : null;
  const ingredients: SearchIngredient[] = recipe.ingredients.map((item) => ({
    id: item.ingredientId,
    name: item.name,
    department: item.department,
    grams:
      item.normalizedUnit === 'szt'
        ? item.normalizedAmount *
          (item.gramsPerPiece ?? FALLBACK_GRAMS_PER_PIECE)
        : item.normalizedAmount,
    pantry: PANTRY_DEPARTMENTS.some((prefix) =>
      normalizeText(item.department).startsWith(prefix),
    ),
  }));
  const mainIngredients = [...ingredients]
    .sort((a, b) =>
      b.grams !== a.grams
        ? b.grams - a.grams
        : a.name.localeCompare(b.name, 'pl'),
    )
    .slice(0, DIGEST_INGREDIENT_LIMIT)
    .map((ingredient) => ingredient.name);
  const tags = recipeSearchTags({
    title: recipe.title,
    mealType: recipe.mealType,
    prepTimeMinutes: recipe.prepTimeMinutes,
    perServing: perServing
      ? { kcal: perServing.kcal, protein: perServing.protein }
      : null,
    ingredients,
  });
  return {
    id: recipe.id,
    ref,
    title: recipe.title,
    mealType: recipe.mealType,
    slots:
      recipe.suitableMealTypes.length > 0
        ? recipe.suitableMealTypes
        : [recipe.mealType],
    servings,
    prepTimeMinutes: recipe.prepTimeMinutes,
    perServing,
    allergens: recipe.allergens,
    dietTags: recipe.dietTags,
    ingredients,
    mainIngredients,
    tags,
    household,
    words: {
      title: words(recipe.title),
      tags: tags.flatMap((tag) => words(RECIPE_TAG_LABELS[tag].words)),
      ingredients: ingredients.flatMap((ingredient) => words(ingredient.name)),
      description: words(recipe.description ?? ''),
    },
  };
}

// ── Tekst ──────────────────────────────────────────────────────────────────

/**
 * Słowa, które nic nie mówią o daniu. Pory posiłku też: od nich jest pole
 * `meal_type`, a „obiad" w tekście trafiałby w przypadkowe tytuły.
 */
const STOPWORDS = new Set([
  'a',
  'ale',
  'albo',
  'co',
  'cos',
  'czyms',
  'czegos',
  'dla',
  'do',
  'i',
  'jakies',
  'jakis',
  'lub',
  'mam',
  'mi',
  'na',
  'nie',
  'o',
  'od',
  'po',
  'pod',
  'przez',
  'w',
  'we',
  'z',
  'ze',
  'za',
  'danie',
  'dania',
  'przepis',
  'przepisy',
  'pomysl',
  'pomysly',
  'propozycja',
  'chce',
  'zrobic',
  'ugotowac',
  'sniadanie',
  'sniadania',
  'obiad',
  'obiady',
  'kolacja',
  'kolacje',
  'kolacji',
  'przekaska',
  'podwieczorek',
  'lunch',
]);

/**
 * Rdzeń słowa dla polskiej odmiany: „kurczakiem" → „kurcza", „zupy" → „zup",
 * „lekkiego" → „lekki". Dopasowanie idzie od POCZĄTKU wyrazu (`hasPrefix`),
 * więc rdzeń nie łapie środka innych słów.
 */
export function stem(word: string): string {
  if (word.length <= 3) return word;
  if (word.length <= 5) return word.slice(0, word.length - 1);
  return word.slice(0, Math.max(5, Math.ceil(word.length * 0.6)));
}

/**
 * Znaczące rdzenie zapytania. Słowo po „bez" wypada: „bez mięsa" w tekście
 * nie może PROMOWAĆ dań z mięsem — od wykluczeń jest `exclude_ingredients`.
 */
export function queryStems(text: string): string[] {
  const tokens = words(text);
  const stems: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === 'bez') {
      i += 1;
      continue;
    }
    if (token.length < 3 || STOPWORDS.has(token)) continue;
    const root = stem(token);
    if (!stems.includes(root)) stems.push(root);
  }
  return stems;
}

/**
 * Wyraz zaczyna się od rdzenia. Krótki rdzeń (do 3 liter) łapie tylko krótką
 * końcówkę: „ser" trafia w „serek", ale nie w „sernik", „por" — w „pory",
 * ale nie w „porcję".
 */
const hasPrefix = (list: readonly string[], root: string): boolean =>
  list.some(
    (word) =>
      word.startsWith(root) &&
      (root.length > 3 || word.length <= root.length + 2),
  );

const TEXT_WEIGHTS = {
  title: 3,
  tags: 2,
  ingredients: 2,
  description: 1,
} as const;

/** Suma najlepszych trafień rdzeni (0 = nic). Rdzeń bez trafienia daje 0. */
function textScore(
  recipe: SearchableRecipe,
  stems: readonly string[],
): {
  score: number;
  matched: string[];
} {
  let score = 0;
  const matched: string[] = [];
  for (const root of stems) {
    let best = 0;
    for (const field of [
      'title',
      'tags',
      'ingredients',
      'description',
    ] as const) {
      if (hasPrefix(recipe.words[field], root)) {
        best = Math.max(best, TEXT_WEIGHTS[field]);
      }
    }
    if (best > 0) matched.push(root);
    score += best;
  }
  return { score, matched };
}

/**
 * Czy składnik przepisu odpowiada nazwie z prośby: KAŻDE znaczące słowo
 * nazwy (po rdzeniu) zaczyna któryś wyraz składnika. „pierś z kurczaka"
 * pasuje do „Filet z piersi kurczaka", „jajka" do „Jajko".
 */
export function ingredientMatches(
  ingredientName: string,
  wanted: string,
): boolean {
  const roots = queryStems(wanted);
  if (roots.length === 0) return false;
  const have = words(ingredientName);
  return roots.every((root) => hasPrefix(have, root));
}

// ── Kryteria ───────────────────────────────────────────────────────────────

export const SEARCH_SORTS = [
  'BEST_FIT',
  'QUICKEST',
  'HIGH_PROTEIN',
  'LIGHTEST',
] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

export const SEARCH_DEFAULT_LIMIT = 8;
export const SEARCH_MAX_LIMIT = 15;

export type RecipeSearchQuery = {
  text: string;
  mealType: MealType | null;
  tags: RecipeSearchTag[];
  includeIngredients: string[];
  excludeIngredients: string[];
  maxPrepMinutes: number | null;
  maxKcalPerServing: number | null;
  minProteinPerServing: number | null;
  sort: SearchSort;
  limit: number;
};

/** Ograniczenia JEDZĄCYCH — twarde, nie do poluzowania przez model. */
export type SearchAudience = {
  allergens: string[];
  excludedIngredientIds: string[];
  diets: DietPreferenceValue[];
};

/** Sygnały rankingu z domu — wszystkie opcjonalne w sensie „puste = brak". */
export type SearchSignals = {
  /** Przepisy w planie PLANOWANEGO tygodnia. */
  plannedThisWeek: ReadonlySet<string>;
  /** Przepisy z poprzedniego tygodnia. */
  plannedLastWeek: ReadonlySet<string>;
  favorites: ReadonlySet<string>;
  /** Składniki (bez przypraw) dań z planu tygodnia — „i tak będą kupione". */
  weekIngredientIds: ReadonlySet<string>;
  /** Ile razy przepis stał w planach wszystkich domów. */
  popularity: ReadonlyMap<string, number>;
};

export const EMPTY_SIGNALS: SearchSignals = {
  plannedThisWeek: new Set(),
  plannedLastWeek: new Set(),
  favorites: new Set(),
  weekIngredientIds: new Set(),
  popularity: new Map(),
};

export function passesAudience(
  recipe: SearchableRecipe,
  audience: SearchAudience,
): boolean {
  if (conflictingAllergens(recipe.allergens, audience.allergens).length > 0) {
    return false;
  }
  if (audience.excludedIngredientIds.length > 0) {
    const excluded = new Set(audience.excludedIngredientIds);
    if (recipe.ingredients.some((ingredient) => excluded.has(ingredient.id))) {
      return false;
    }
  }
  const subject = {
    dietTags: recipe.dietTags,
    hasIngredientData: recipe.ingredients.length > 0,
    perServing: recipe.perServing,
  };
  return audience.diets.every((diet) => satisfiesDiet(diet, subject));
}

type SoftFilter =
  | 'meal_type'
  | 'tags'
  | 'include_ingredients'
  | 'exclude_ingredients'
  | 'max_prep_minutes'
  | 'max_kcal_per_serving'
  | 'min_protein_per_serving';

function tagsMatch(
  recipe: SearchableRecipe,
  wanted: readonly RecipeSearchTag[],
): boolean {
  if (wanted.length === 0) return true;
  const groups = new Map<RecipeTagGroup, RecipeSearchTag[]>();
  for (const tag of wanted) {
    const group = tagGroup(tag);
    groups.set(group, [...(groups.get(group) ?? []), tag]);
  }
  // W obrębie grupy LUB („zupy albo sałatki"), między grupami I („zupy z drobiem").
  for (const tags of groups.values()) {
    if (!tags.some((tag) => recipe.tags.includes(tag))) return false;
  }
  return true;
}

function passesSoft(
  recipe: SearchableRecipe,
  query: RecipeSearchQuery,
  skip: SoftFilter | null = null,
): boolean {
  if (skip !== 'meal_type' && query.mealType) {
    if (!recipe.slots.includes(query.mealType)) return false;
  }
  if (skip !== 'tags' && !tagsMatch(recipe, query.tags)) return false;
  if (skip !== 'include_ingredients') {
    for (const wanted of query.includeIngredients) {
      if (
        !recipe.ingredients.some((ingredient) =>
          ingredientMatches(ingredient.name, wanted),
        )
      ) {
        return false;
      }
    }
  }
  if (skip !== 'exclude_ingredients') {
    for (const unwanted of query.excludeIngredients) {
      if (
        recipe.ingredients.some((ingredient) =>
          ingredientMatches(ingredient.name, unwanted),
        )
      ) {
        return false;
      }
    }
  }
  if (skip !== 'max_prep_minutes' && query.maxPrepMinutes !== null) {
    // 0 minut to „nie wiemy", nie „od ręki" — takie danie nie przechodzi
    // limitu czasu, bo nie da się obiecać, że się w nim zmieści.
    if (
      recipe.prepTimeMinutes <= 0 ||
      recipe.prepTimeMinutes > query.maxPrepMinutes
    ) {
      return false;
    }
  }
  if (skip !== 'max_kcal_per_serving' && query.maxKcalPerServing !== null) {
    if (
      !recipe.perServing ||
      recipe.perServing.kcal > query.maxKcalPerServing
    ) {
      return false;
    }
  }
  if (
    skip !== 'min_protein_per_serving' &&
    query.minProteinPerServing !== null
  ) {
    if (
      !recipe.perServing ||
      recipe.perServing.protein < query.minProteinPerServing
    ) {
      return false;
    }
  }
  return true;
}

function activeSoftFilters(query: RecipeSearchQuery): SoftFilter[] {
  const active: SoftFilter[] = [];
  if (query.mealType) active.push('meal_type');
  if (query.tags.length > 0) active.push('tags');
  if (query.includeIngredients.length > 0) active.push('include_ingredients');
  if (query.excludeIngredients.length > 0) active.push('exclude_ingredients');
  if (query.maxPrepMinutes !== null) active.push('max_prep_minutes');
  if (query.maxKcalPerServing !== null) active.push('max_kcal_per_serving');
  if (query.minProteinPerServing !== null) {
    active.push('min_protein_per_serving');
  }
  return active;
}

// ── Ranking ────────────────────────────────────────────────────────────────

const WEIGHTS = {
  /** Mnożnik sumy trafień tekstu (tytuł 3, tag 2, składnik 2, opis 1). */
  text: 1,
  favorite: 1.5,
  plannedThisWeek: -3,
  plannedLastWeek: -1.5,
  /** Za każdy składnik wspólny z planem tygodnia, najwyżej `sharedCap`. */
  sharedIngredient: 0.5,
  sharedCap: 1.5,
  /** Popularność: log10(1 + liczba planów) / 2, najwyżej 1. */
  popularityCap: 1,
  /** Kara w dywersyfikacji za każde danie tego samego rodzaju już w wyniku. */
  sameDish: 1,
} as const;

type Scored = {
  recipe: SearchableRecipe;
  score: number;
  matched: string[];
  shared: string[];
};

function fitScore(
  recipe: SearchableRecipe,
  stems: readonly string[],
  signals: SearchSignals,
): Scored {
  const text = textScore(recipe, stems);
  let score = text.score * WEIGHTS.text;
  if (signals.favorites.has(recipe.id)) score += WEIGHTS.favorite;
  if (signals.plannedThisWeek.has(recipe.id)) {
    score += WEIGHTS.plannedThisWeek;
  } else if (signals.plannedLastWeek.has(recipe.id)) {
    score += WEIGHTS.plannedLastWeek;
  }
  const shared = recipe.ingredients
    .filter(
      (ingredient) =>
        !ingredient.pantry && signals.weekIngredientIds.has(ingredient.id),
    )
    .map((ingredient) => ingredient.name);
  score += Math.min(
    WEIGHTS.sharedCap,
    shared.length * WEIGHTS.sharedIngredient,
  );
  const plans = signals.popularity.get(recipe.id) ?? 0;
  score += Math.min(WEIGHTS.popularityCap, Math.log10(1 + plans) / 2);
  return { recipe, score, matched: text.matched, shared };
}

function sortKey(entry: Scored, sort: SearchSort): number {
  const per = entry.recipe.perServing;
  switch (sort) {
    case 'QUICKEST':
      return entry.recipe.prepTimeMinutes > 0
        ? entry.recipe.prepTimeMinutes
        : Number.POSITIVE_INFINITY;
    case 'HIGH_PROTEIN':
      return per ? -per.protein : Number.POSITIVE_INFINITY;
    case 'LIGHTEST':
      return per && per.kcal > 0 ? per.kcal : Number.POSITIVE_INFINITY;
    case 'BEST_FIT':
      return -entry.score;
  }
}

function compare(a: Scored, b: Scored, sort: SearchSort): number {
  const ka = sortKey(a, sort);
  const kb = sortKey(b, sort);
  if (ka !== kb) {
    // Brak liczby (danie bez makr, bez czasu) zawsze na koniec.
    if (!Number.isFinite(ka)) return 1;
    if (!Number.isFinite(kb)) return -1;
    return ka - kb;
  }
  if (b.score !== a.score) return b.score - a.score;
  return a.recipe.title.localeCompare(b.recipe.title, 'pl');
}

const dishOf = (recipe: SearchableRecipe): RecipeSearchTag | null =>
  recipe.tags.find((tag) => tagGroup(tag) === 'dish') ?? null;

/**
 * Wybór `limit` pozycji z posortowanej listy. Przy BEST_FIT z karą za
 * powtórzony rodzaj dania — „coś na obiad" nie oddaje pięciu zup z rzędu.
 * Przy sortowaniu po liczbie (najszybsze, najlżejsze) kolejność jest
 * obietnicą, więc bez dywersyfikacji.
 */
function pick(sorted: Scored[], limit: number, sort: SearchSort): Scored[] {
  if (sort !== 'BEST_FIT') return sorted.slice(0, limit);
  const pool = sorted.slice(0, limit * 4);
  const chosen: Scored[] = [];
  const dishCount = new Map<string, number>();
  while (chosen.length < limit && pool.length > 0) {
    let bestIndex = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    pool.forEach((entry, index) => {
      const dish = dishOf(entry.recipe);
      const penalty = dish ? (dishCount.get(dish) ?? 0) * WEIGHTS.sameDish : 0;
      const value = entry.score - penalty;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = index;
      }
    });
    const [next] = pool.splice(bestIndex, 1);
    chosen.push(next);
    const dish = dishOf(next.recipe);
    if (dish) dishCount.set(dish, (dishCount.get(dish) ?? 0) + 1);
  }
  return chosen;
}

// ── Wynik ──────────────────────────────────────────────────────────────────

export type RecipeHit = {
  recipe: string;
  title: string;
  slots: MealType[];
  kcal: number | null;
  protein: number | null;
  fat: number | null;
  carbs: number | null;
  prepMinutes: number;
  servings: number;
  allergens: string[];
  dietTags: string[];
  tags: RecipeSearchTag[];
  mainIngredients: string[];
  /** Dlaczego to danie jest wysoko — po ludzku, do zacytowania. */
  why: string[];
  household?: true;
};

export type RecipeSearchResult = {
  /** Ile dań spełnia kryteria (przed obcięciem do `limit`). */
  total: number;
  hits: RecipeHit[];
  /**
   * Tekst nie trafił w żadne danie spełniające kryteria, więc wyniki są BEZ
   * niego — model ma wiedzieć, że „coś rozgrzewającego" nie zadziałało
   * jako słowa i sięgnąć po tagi.
   */
  textIgnored: boolean;
  /**
   * Przy zerowym wyniku: ile dań byłoby po zdjęciu JEDNEGO kryterium z prośby
   * (nigdy alergenów ani diety — te nie są do negocjacji).
   */
  relaxations?: { without: SoftFilter; total: number }[];
};

const round = (value: number): number => Math.round(value);

function describe(entry: Scored, signals: SearchSignals): string[] {
  const why: string[] = [];
  if (entry.matched.length > 0) {
    why.push(`pasuje do słów: ${entry.matched.join(', ')}`);
  }
  if (signals.favorites.has(entry.recipe.id)) why.push('ulubione domu');
  if (entry.shared.length > 0) {
    why.push(
      `wspólne z planem tygodnia: ${entry.shared.slice(0, 3).join(', ')}`,
    );
  }
  if (signals.plannedThisWeek.has(entry.recipe.id)) {
    why.push('JUŻ jest w planie tego tygodnia');
  } else if (signals.plannedLastWeek.has(entry.recipe.id)) {
    why.push('było w planie w zeszłym tygodniu');
  }
  return why;
}

function toHit(entry: Scored, signals: SearchSignals): RecipeHit {
  const { recipe } = entry;
  const per = recipe.perServing;
  return {
    recipe: recipe.ref,
    title: recipe.title,
    slots: recipe.slots,
    kcal: per ? round(per.kcal) : null,
    protein: per ? round(per.protein) : null,
    fat: per ? round(per.fat) : null,
    carbs: per ? round(per.carbs) : null,
    prepMinutes: recipe.prepTimeMinutes,
    servings: recipe.servings,
    allergens: recipe.allergens,
    dietTags: recipe.dietTags,
    tags: recipe.tags,
    mainIngredients: recipe.mainIngredients,
    why: describe(entry, signals),
    ...(recipe.household ? { household: true as const } : {}),
  };
}

export function searchRecipes(
  recipes: readonly SearchableRecipe[],
  query: RecipeSearchQuery,
  audience: SearchAudience,
  signals: SearchSignals = EMPTY_SIGNALS,
): RecipeSearchResult {
  const safe = recipes.filter((recipe) => passesAudience(recipe, audience));
  const candidates = safe.filter((recipe) => passesSoft(recipe, query));

  const stems = queryStems(query.text);
  let scored = candidates.map((recipe) => fitScore(recipe, stems, signals));
  let textIgnored = false;
  if (stems.length > 0) {
    const matching = scored.filter((entry) => entry.matched.length > 0);
    if (matching.length > 0) {
      scored = matching;
    } else {
      textIgnored = true;
    }
  }

  const sorted = [...scored].sort((a, b) => compare(a, b, query.sort));
  const limit = Math.min(
    SEARCH_MAX_LIMIT,
    Math.max(1, Math.round(query.limit) || SEARCH_DEFAULT_LIMIT),
  );
  const hits = pick(sorted, limit, query.sort).map((entry) =>
    toHit(entry, signals),
  );

  const result: RecipeSearchResult = {
    total: scored.length,
    hits,
    textIgnored,
  };
  if (scored.length === 0) {
    result.relaxations = activeSoftFilters(query)
      .map((without) => ({
        without,
        total: safe.filter((recipe) => passesSoft(recipe, query, without))
          .length,
      }))
      .filter((entry) => entry.total > 0);
  }
  return result;
}

// ── Mapa katalogu ──────────────────────────────────────────────────────────

const SLOT_LABELS: Record<MealType, string> = {
  BREAKFAST: 'śniadanie',
  SECOND_BREAKFAST: 'II śniadanie',
  LUNCH: 'obiad',
  AFTERNOON_SNACK: 'podwieczorek',
  DINNER: 'kolacja',
  SNACK: 'przekąska',
};

const SLOT_ORDER: MealType[] = [
  'BREAKFAST',
  'SECOND_BREAKFAST',
  'LUNCH',
  'AFTERNOON_SNACK',
  'DINNER',
  'SNACK',
];

/**
 * Mapa katalogu do promptu — STAŁEGO rozmiaru, niezależnie od liczby dań.
 *
 * Zastępuje digest (linia na przepis): model wie, CO jest w katalogu i po
 * czym może szukać, ale samych dań nie widzi — sięga po nie `find_recipes`.
 * Deterministyczna: te same dane dają ten sam tekst, bo to prefiks cache.
 * `refWidth` mówi, ile cyfr ma indeks (R07 vs R007), żeby przykład w mapie
 * zgadzał się z tym, co model dostanie w wynikach.
 */
export function buildCatalogMap(
  recipes: readonly SearchableRecipe[],
  refWidth: number,
): string {
  const perSlot = SLOT_ORDER.map((slot) => ({
    slot,
    count: recipes.filter((recipe) => recipe.slots.includes(slot)).length,
  })).filter((entry) => entry.count > 0);
  const perTag = RECIPE_SEARCH_TAGS.map((tag) => ({
    tag,
    count: recipes.filter((recipe) => recipe.tags.includes(tag)).length,
  })).filter((entry) => entry.count > 0);
  const example = `R${'7'.padStart(refWidth, '0')}`;

  return [
    'KATALOG PRZEPISÓW — MAPA. Samych dań NIE MA w tym prompcie: szukasz ich narzędziem',
    'find_recipes, które zwraca najlepiej dopasowane dania z makro na porcję.',
    `W katalogu jest ${recipes.length} dań. Na pory: ${perSlot
      .map((entry) => `${SLOT_LABELS[entry.slot]} ${entry.count}`)
      .join(', ')}.`,
    'Tagi (pole tags w find_recipes; w nawiasie liczba dań):',
    ...perTag.map(
      (entry) =>
        `- ${entry.tag} — ${RECIPE_TAG_LABELS[entry.tag].label} (${entry.count})`,
    ),
    'Tagi z jednej grupy (rodzaj dania, mięso, smak) łączą się przez LUB, grupy — przez I.',
    `Referencje dań to indeksy z wyników (np. ${example}) albo identyfikatory przepisów domu —`,
    'przepisujesz je DOSŁOWNIE do innych narzędzi, nigdy nie zgadujesz ani nie liczysz.',
    'Alergeny, wykluczenia i dietę jedzących find_recipes nakłada SAM (tymi samymi regułami,',
    'co walidator planu) — nie musisz ich podawać, a danie spoza wyniku nie jest bezpieczne',
    'tylko dlatego, że go nie widzisz.',
  ].join('\n');
}
