/**
 * Taksonomia przepisu (katalog 1000, 28.09.2026) — pola, których NIE da się
 * wyliczyć ze składników: kuchnia, rodzaj dania, pory roku, okazje, sprzęt
 * i cechy dla planera. Alergeny, tagi diet, makro, „szybkie” i „lekkie”
 * dalej liczą się z danych (`diet-tags.ts`, `recipe-facets.util.ts`).
 *
 * Id są kontraktem z klientami (iOS, Android, panel) — jak alergeny: nową
 * wartość dokłada się NAJPIERW tu i na prod, potem w klientach, a klient
 * nieznaną wartość pomija (nie odrzuca przepisu).
 *
 * Kolumny w bazie to zwykłe napisy (jak `dietTags`), więc nowa wartość nie
 * wymaga migracji; poprawność pilnuje `taxonomyProblems` przy każdym zapisie
 * katalogu (import, panel).
 */

/** Kuchnia — jedna na przepis. `OTHER` = międzynarodowa albo spoza listy. */
export const RECIPE_CUISINES = [
  'POLISH',
  'ITALIAN',
  'SPANISH',
  'GREEK',
  'INDIAN',
  'THAI',
  'MEXICAN',
  'AMERICAN',
  'OTHER',
] as const;
export type RecipeCuisine = (typeof RECIPE_CUISINES)[number];

/**
 * Rodzaj dania — jeden na przepis. Ten sam słownik co tagi wyszukiwania
 * asystenta (`RECIPE_DISH_TAGS`, małymi literami) plus `MAIN`: mięso albo
 * ryba z dodatkiem, którego nazwa nie przesądza (karp smażony, stek).
 */
export const RECIPE_DISH_TYPES = [
  'SOUP',
  'SALAD',
  'PASTA',
  'GRAINS',
  'POTATOES',
  'DUMPLINGS',
  'STEW',
  'MAIN',
  'PORRIDGE',
  'EGGS',
  'SANDWICH',
  'PANCAKES',
  'YOGURT',
  'BAKE',
  'CAKE',
  'DESSERT',
  'CRUNCHY',
  'BITES',
  'DIP',
  'DRINK',
] as const;
export type RecipeDishType = (typeof RECIPE_DISH_TYPES)[number];

/** Pory roku; przepis bez pór = cały rok. */
export const RECIPE_SEASONS = ['SPRING', 'SUMMER', 'AUTUMN', 'WINTER'] as const;
export type RecipeSeason = (typeof RECIPE_SEASONS)[number];

/** Okazje — do filtra „na Wigilię”, „na grilla”, „na imprezę”. */
export const RECIPE_OCCASIONS = [
  'CHRISTMAS_EVE',
  'CHRISTMAS',
  'EASTER',
  'BARBECUE',
  'PARTY',
] as const;
export type RecipeOccasion = (typeof RECIPE_OCCASIONS)[number];

/**
 * Sprzęt potrzebny poza płytą, garnkiem i patelnią. Przepis na airfryer ma
 * w krokach wariant na piekarnik, ale sprzęt podaje ten, pod który jest
 * napisany.
 */
export const RECIPE_EQUIPMENT = [
  'OVEN',
  'AIRFRYER',
  'BLENDER',
  'GRILL',
  'JUICER',
  'WAFFLE_MAKER',
] as const;
export type RecipeEquipment = (typeof RECIPE_EQUIPMENT)[number];

/**
 * Cechy dla filtrów i planera:
 * - `LUNCHBOX` — znosi transport w pudełku (na zimno albo do odgrzania);
 * - `SIDE` — dodatek do posiłku (sok, kompot), planer nie stawia go w slocie
 *   zamiast posiłku;
 * - `OCCASIONAL` — tylko od święta: planer proponuje go wyłącznie w okresie
 *   jego okazji albo na wyraźną prośbę (karp, mazurek, krążki cebulowe na
 *   imprezę), ręcznie można go dodać zawsze.
 */
export const RECIPE_FEATURES = ['LUNCHBOX', 'SIDE', 'OCCASIONAL'] as const;
export type RecipeFeature = (typeof RECIPE_FEATURES)[number];

/** Pola taksonomii w kształcie kolumn `Recipe`. */
export type RecipeTaxonomy = {
  cuisine: string;
  dishType: string | null;
  seasons: string[];
  occasions: string[];
  equipment: string[];
  features: string[];
};

/** Przepis bez decyzji redakcji — domyślne wartości kolumn. */
export const EMPTY_RECIPE_TAXONOMY: RecipeTaxonomy = {
  cuisine: 'OTHER',
  dishType: null,
  seasons: [],
  occasions: [],
  equipment: [],
  features: [],
};

const LISTS = {
  seasons: RECIPE_SEASONS,
  occasions: RECIPE_OCCASIONS,
  equipment: RECIPE_EQUIPMENT,
  features: RECIPE_FEATURES,
} as const satisfies Record<string, readonly string[]>;

type ListField = keyof typeof LISTS;

/**
 * Lista w kanonicznym porządku słownika i bez powtórzeń — plik katalogu
 * i odpowiedzi API mają jeden zapis tej samej listy, niezależnie od tego,
 * w jakiej kolejności ktoś ją wpisał w panelu.
 */
export function canonicalTaxonomyList(
  field: ListField,
  values: readonly string[],
): string[] {
  const set = new Set(values);
  return (LISTS[field] as readonly string[]).filter((id) => set.has(id));
}

/** Taksonomia z kanonicznym porządkiem list (wartości spoza słownika wypadają). */
export function canonicalTaxonomy(taxonomy: RecipeTaxonomy): RecipeTaxonomy {
  return {
    cuisine: taxonomy.cuisine,
    dishType: taxonomy.dishType,
    seasons: canonicalTaxonomyList('seasons', taxonomy.seasons),
    occasions: canonicalTaxonomyList('occasions', taxonomy.occasions),
    equipment: canonicalTaxonomyList('equipment', taxonomy.equipment),
    features: canonicalTaxonomyList('features', taxonomy.features),
  };
}

/**
 * Naruszenia słowników — pusta lista = poprawnie. Nieznana wartość to błąd,
 * nie cicha poprawka: literówka w panelu nie może zniknąć bez śladu.
 */
export function taxonomyProblems(taxonomy: Partial<RecipeTaxonomy>): string[] {
  const problems: string[] = [];
  if (
    taxonomy.cuisine !== undefined &&
    !(RECIPE_CUISINES as readonly string[]).includes(taxonomy.cuisine)
  ) {
    problems.push(`nieznana kuchnia "${taxonomy.cuisine}"`);
  }
  if (
    taxonomy.dishType !== undefined &&
    taxonomy.dishType !== null &&
    !(RECIPE_DISH_TYPES as readonly string[]).includes(taxonomy.dishType)
  ) {
    problems.push(`nieznany rodzaj dania "${taxonomy.dishType}"`);
  }
  for (const field of Object.keys(LISTS) as ListField[]) {
    const values = taxonomy[field];
    if (values === undefined) continue;
    if (!Array.isArray(values)) {
      problems.push(`${field} musi być listą`);
      continue;
    }
    const allowed = LISTS[field] as readonly string[];
    for (const value of values) {
      if (!allowed.includes(value)) {
        problems.push(`${field}: nieznana wartość "${String(value)}"`);
      }
    }
    if (new Set(values).size !== values.length) {
      problems.push(`${field}: wartość powtórzona`);
    }
  }
  return problems;
}

/** Pora roku dla daty (meteorologicznie: wiosna = marzec–maj itd.). */
export function seasonOf(date: Date): RecipeSeason {
  const month = date.getUTCMonth() + 1;
  if (month >= 3 && month <= 5) return 'SPRING';
  if (month >= 6 && month <= 8) return 'SUMMER';
  if (month >= 9 && month <= 11) return 'AUTUMN';
  return 'WINTER';
}
