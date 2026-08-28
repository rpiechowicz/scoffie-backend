/**
 * Tagi dietetyczne składnika (`Ingredient.dietTags`) i reguła wyprowadzania
 * tagów przepisu (`Recipe.allergens`, `Recipe.dietTags`).
 *
 * Źródłem prawdy jest kuratorowany, wersjonowany w gicie plik
 * `prisma/catalog/ingredient-tags-pl-v1.json` (klucz `normalizedName`, jak w
 * tabeli makro), wgrywany skryptem `pnpm catalog:ingredients:tags`. Tagi
 * przepisu to UNIA tagów jego składników — liczona przy imporcie
 * (`scripts/import-recipes-from-json.ts`), przy `recipes:create`
 * (`RecipesService`) i w przebiegu „recompute” loadera. Reguły diet czytają
 * te tagi w `src/recipes/diet-rules.util.ts`; klient iOS dostaje je w liście
 * i w szczegółach przepisu i przestaje zgadywać z nazw składników
 * (`RecipeDietProfile.swift` zostaje tylko fallbackiem dla starego serwera).
 *
 * Alergeny przepisu używają TYCH SAMYCH id co `UserPreference.allergens`
 * (`src/common/allergens.ts`), więc „czy przepis koliduje z alergenami
 * domownika” to zwykłe przecięcie zbiorów — bez tłumaczenia słowników.
 */
export const DIET_TAG_IDS = [
  /** Mięso i drób, podroby, wędliny, buliony mięsne. */
  'MEAT',
  /** Ryby i przetwory rybne. */
  'FISH',
  /** Skorupiaki (zawsze razem z FISH — alergen `fish` je obejmuje). */
  'CRUSTACEAN',
  /** Wszystko z mleka zwierzęcego, także bez laktozy, masło, ghee, serwatka. */
  'DAIRY',
  /** Jajko i produkty z jajkiem (majonez). */
  'EGG',
  /** Odzwierzęce poza mięsem/rybą/nabiałem/jajkiem: miód, żelatyna, kolagen, smalec. */
  'ANIMAL_OTHER',
  /** Pszenica, żyto, jęczmień, owies i ich przetwory — zawsze razem z GRAIN. */
  'GLUTEN_GRAIN',
  /** Wszystkie zboża i pseudozboża (ryż, kukurydza, gryka, jaglana, quinoa…). */
  'GRAIN',
  /** Rośliny strączkowe, w tym soja, tofu, orzeszki ziemne, hummus. */
  'LEGUME',
  /** Żywność wysoko przetworzona (słodycze, wędliny, gotowe sosy, cukier). */
  'PROCESSED',
  /** Napoje alkoholowe. */
  'ALCOHOL',
  /** Artykuły niespożywcze (chemia, gospodarstwo) — zawsze jako jedyny tag. */
  'NON_FOOD',
] as const;

export type DietTagId = (typeof DIET_TAG_IDS)[number];

/** Mutowalna kopia dla `@ApiProperty({ enum })` i walidacji plików. */
export const DIET_TAG_ID_VALUES: string[] = [...DIET_TAG_IDS];

export function isDietTagId(value: unknown): value is DietTagId {
  return typeof value === 'string' && DIET_TAG_ID_VALUES.includes(value);
}

export type TaggedIngredient = {
  allergens: readonly string[];
  dietTags: readonly string[];
};

export type RecipeTags = {
  allergens: string[];
  dietTags: string[];
};

/**
 * Unia tagów składników, posortowana i bez duplikatów — ta sama funkcja we
 * wszystkich trzech miejscach zapisu, żeby import, `recipes:create` i
 * recompute nie mogły się rozjechać. Przepis bez składników ma puste listy;
 * czytający (iOS, walidator) rozróżniają „brak składników” po
 * `ingredients.length`, nie po pustych tagach.
 */
export function deriveRecipeTags(
  ingredients: readonly TaggedIngredient[],
): RecipeTags {
  const allergens = new Set<string>();
  const dietTags = new Set<string>();
  for (const ingredient of ingredients) {
    for (const id of ingredient.allergens ?? []) allergens.add(id);
    for (const id of ingredient.dietTags ?? []) dietTags.add(id);
  }
  return {
    allergens: Array.from(allergens).sort(),
    dietTags: Array.from(dietTags).sort(),
  };
}

export type IngredientTagEntry = {
  name: string;
  normalizedName: string;
  allergens: string[];
  dietTags: string[];
  note?: string;
};

/**
 * Reguły spójności wpisu w pliku tagów — te same, których pilnuje kuracja.
 * Wołane przez loader (przerywa wgrywanie) i przez golden spec (pilnuje
 * pliku w gicie). Zwraca listę naruszeń; pusta = wpis poprawny.
 */
export function validateIngredientTagEntry(
  entry: IngredientTagEntry,
  allergenIds: readonly string[],
): string[] {
  const problems: string[] = [];
  const a = new Set(entry.allergens);
  const d = new Set(entry.dietTags);

  for (const id of entry.allergens) {
    if (!allergenIds.includes(id)) problems.push(`nieznany alergen "${id}"`);
  }
  for (const id of entry.dietTags) {
    if (!isDietTagId(id)) problems.push(`nieznany dietTag "${id}"`);
  }
  if (a.size !== entry.allergens.length) problems.push('duplikaty w allergens');
  if (d.size !== entry.dietTags.length) problems.push('duplikaty w dietTags');

  const implies = (when: boolean, then: boolean, rule: string) => {
    if (when && !then) problems.push(rule);
  };
  implies(a.has('gluten'), d.has('GLUTEN_GRAIN'), 'gluten ⇒ GLUTEN_GRAIN');
  implies(d.has('GLUTEN_GRAIN'), d.has('GRAIN'), 'GLUTEN_GRAIN ⇒ GRAIN');
  implies(a.has('lactose'), d.has('DAIRY'), 'lactose ⇒ DAIRY');
  implies(a.has('eggs'), d.has('EGG'), 'eggs ⇒ EGG');
  implies(a.has('fish'), d.has('FISH'), 'fish ⇒ FISH');
  implies(
    d.has('CRUSTACEAN'),
    d.has('FISH') && a.has('fish'),
    'CRUSTACEAN ⇒ FISH + fish',
  );
  implies(a.has('soy'), d.has('LEGUME'), 'soy ⇒ LEGUME');
  implies(a.has('peanuts'), d.has('LEGUME'), 'peanuts ⇒ LEGUME');
  if (d.has('NON_FOOD') && (d.size !== 1 || a.size !== 0)) {
    problems.push('NON_FOOD musi być jedynym tagiem, bez alergenów');
  }
  return problems;
}

/** Porównanie list tagów jako zbiorów (kolejność w bazie nie jest gwarantowana). */
export function sameTags(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}
