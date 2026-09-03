import { createHash } from 'crypto';
import { MealType, PrismaClient } from '@prisma/client';

/**
 * Digest katalogu — cały katalog przepisów ściśnięty do jednego bloku tekstu,
 * który jedzie w prefiksie każdego zapytania do modelu.
 *
 * Po co w ogóle: asystent musi WIEDZIEĆ, z czego układa plan. Alternatywa —
 * wyszukiwarka jako narzędzie — znaczy jedną turę więcej na każde pytanie
 * („czego szukam?" → wynik → dopiero odpowiedź), a przy 89 przepisach cały
 * katalog i tak mieści się w kilku tysiącach tokenów i siedzi w cache po
 * 0,1× stawki. Narzędzie wyszukujące dokłada się dopiero, gdy katalog urośnie
 * na tyle, że digest przestanie się opłacać (analiza asystenta, §Architektura).
 *
 * Trzy decyzje o kształcie linii:
 *
 * 1. **Krótki indeks `R01`, nie UUID.** `Recipe.id` to UUID, a UUID kosztuje
 *    20–25 tokenów — przy 89 przepisach samo id to ~2k tokenów, czyli jedna
 *    czwarta digestu za nic. Model operuje na indeksie, kod tłumaczy go z
 *    powrotem na `recipeId` (`CatalogDigest.index`). Indeks NIE jest trwały:
 *    zmiana katalogu przenumerowuje go i unieważnia cache prefiksu — to jest
 *    w porządku, bo katalog zmienia się rzadko, ale dlatego narzędzia MUSZĄ
 *    dostawać `recipeId` z mapy, nigdy indeks zapamiętany z poprzedniej tury.
 * 2. **Makro NA PORCJĘ, nie na przepis.** W bazie `nutritionKcal` i spółka
 *    opisują CAŁY przepis (patrz CLAUDE.md, „Makro = cały przepis"), a
 *    użytkownik i model myślą porcjami. Bez dzielenia asystent widziałby
 *    obiad na 1392 kcal i uznał go za niemożliwy do wpisania w dzienny cel.
 * 3. **Pięć składników posortowanych po MASIE, nie pierwsze z brzegu.**
 *    Wszystkie `RecipeIngredient` jednego przepisu mają identyczny `createdAt`
 *    (wstawiane hurtem przy imporcie), więc „kolejność z bazy" jest losowa —
 *    w Leczo pierwsze pięć wypadało na przyprawę uniwersalną, pieprz i sól,
 *    które nie niosą żadnej informacji o daniu. Sortowanie po gramaturze
 *    wyciąga to, co danie naprawdę definiuje.
 */
export const DIGEST_INGREDIENT_LIMIT = 5;

/** `szt` bez gramatury w katalogu — waga zastępcza tylko do sortowania. */
const FALLBACK_GRAMS_PER_PIECE = 100;

export type DigestIngredient = {
  name: string;
  normalizedAmount: number;
  normalizedUnit: string;
  /** Z `Ingredient.gramsPerPiece`; `null` = nieznana. */
  gramsPerPiece: number | null;
};

export type DigestRecipe = {
  id: string;
  title: string;
  mealType: MealType;
  suitableMealTypes: MealType[];
  prepTimeMinutes: number;
  servings: number;
  /** Wartości dla CAŁEGO przepisu — dzielone przez `servings` przy składaniu linii. */
  nutritionKcal: number;
  nutritionProtein: number;
  nutritionFat: number;
  nutritionCarbs: number;
  /** Id jak w `src/common/allergens.ts` — te same, których używa profil. */
  allergens: string[];
  /** Tagi z `src/common/diet-tags.ts` (MEAT, DAIRY, GLUTEN_GRAIN…). */
  dietTags: string[];
  ingredients: DigestIngredient[];
};

export type CatalogDigest = {
  /** Nagłówek + po jednej linii na przepis. */
  text: string;
  /** `R01` → `Recipe.id`. Jedyna droga od odpowiedzi modelu do bazy. */
  index: Record<string, string>;
  recipeCount: number;
  /**
   * Skrót treści digestu. Zmiana katalogu = nowa wersja = nowy prefiks cache
   * i sygnał dla klienta, że zapamiętane indeksy są nieaktualne.
   */
  catalogVersion: string;
};

export const DIGEST_HEADER = [
  'KATALOG PRZEPISÓW (jedna linia = jeden przepis).',
  'Format: indeks|tytuł|sloty|kcal P(białko) F(tłuszcz) C(węgle) na porcję|czas|porcje|A:alergeny|D:tagi diet|główne składniki',
  'Sloty: BREAKFAST, SECOND_BREAKFAST, LUNCH, AFTERNOON_SNACK, DINNER, SNACK.',
  'Makro dotyczy JEDNEJ porcji. Składniki to 5 najcięższych, NIE CAŁA LISTA —',
  'nie wnioskuj o alergenach z nazw składników, tylko z pola A. Puste A = brak alergenów.',
  'W narzędziach używaj indeksu (R01), nigdy tytułu.',
].join('\n');

/** Nagłówek z przykładem indeksu w SZEROKOŚCI tego katalogu (R01 vs R001). */
function digestHeaderFor(width: number): string {
  const example = `R${'1'.padStart(width, '0')}`;
  return DIGEST_HEADER.replace('(R01)', `(${example})`);
}

/** Masa porównawcza wyłącznie do sortowania — `ml` liczone jak gramy. */
function comparableGrams(ingredient: DigestIngredient): number {
  const { normalizedAmount, normalizedUnit, gramsPerPiece } = ingredient;
  if (normalizedUnit === 'szt') {
    return normalizedAmount * (gramsPerPiece ?? FALLBACK_GRAMS_PER_PIECE);
  }
  return normalizedAmount;
}

function mainIngredients(recipe: DigestRecipe): string[] {
  return [...recipe.ingredients]
    .sort((a, b) => {
      const diff = comparableGrams(b) - comparableGrams(a);
      // Remis rozstrzyga nazwa — digest musi być bajt w bajt taki sam przy
      // każdym uruchomieniu, inaczej cache prefiksu nie trafia.
      return diff !== 0 ? diff : a.name.localeCompare(b.name, 'pl');
    })
    .slice(0, DIGEST_INGREDIENT_LIMIT)
    .map((ingredient) => ingredient.name);
}

function perServing(total: number, servings: number): number {
  return Math.round(total / Math.max(1, servings));
}

export function buildDigestLine(recipe: DigestRecipe, index: string): string {
  const servings = Math.max(1, recipe.servings);
  // `suitableMealTypes` puste = „brak backfillu", czytamy jak `[mealType]`
  // (ta sama zasada, co w domenie — patrz komentarz przy modelu Recipe).
  const slots =
    recipe.suitableMealTypes.length > 0
      ? recipe.suitableMealTypes
      : [recipe.mealType];

  return [
    index,
    recipe.title,
    slots.join(','),
    `${perServing(recipe.nutritionKcal, servings)}kcal ` +
      `P${perServing(recipe.nutritionProtein, servings)} ` +
      `F${perServing(recipe.nutritionFat, servings)} ` +
      `C${perServing(recipe.nutritionCarbs, servings)}`,
    `${recipe.prepTimeMinutes}min`,
    `${servings}p`,
    // Alergeny i diety JAWNIE, a nie do wywnioskowania ze składników: lista
    // składników jest przycięta do pięciu najcięższych, więc 20 g masła
    // w daniu rybnym jest dla modelu niewidoczne. Na katalogu dev 15 z 65
    // przepisów z laktozą nie pokazuje nabiału w tej piątce.
    `A:${recipe.allergens.join(',')}`,
    `D:${recipe.dietTags.join(',')}`,
    mainIngredients(recipe).join(', '),
  ].join('|');
}

/**
 * Buduje digest z listy przepisów. Kolejność wejścia decyduje o numeracji,
 * więc wołający ma ją ustalić deterministycznie (`loadDigestRecipes` sortuje
 * po tytule) — dwa uruchomienia na tym samym katalogu muszą dać identyczny
 * tekst, bo inaczej cache prefiksu nie ma czego trafić.
 */
export function buildCatalogDigest(recipes: DigestRecipe[]): CatalogDigest {
  const width = Math.max(2, String(recipes.length).length);
  const index: Record<string, string> = {};
  const lines = recipes.map((recipe, position) => {
    const key = `R${String(position + 1).padStart(width, '0')}`;
    index[key] = recipe.id;
    return buildDigestLine(recipe, key);
  });

  // Przykład w nagłówku MUSI zgadzać się z danymi: przy 125 przepisach
  // klucze to R001…R125, a model, który poszedł za „R01", tracił rundę.
  const text = [digestHeaderFor(width), ...lines].join('\n');
  return {
    text,
    index,
    recipeCount: recipes.length,
    catalogVersion: createHash('sha256')
      .update(text)
      .digest('hex')
      .slice(0, 12),
  };
}

/**
 * Przepisy katalogu w kolejności alfabetycznej po tytule.
 *
 * Katalog to przepisy gospodarstwa katalogowego (`RECIPE_IMPORT_HOUSEHOLD_ID`)
 * — na dev `22222222-…`, na prod inne, stąd parametr zamiast stałej.
 * Nieaktywne odpadają: `isActive=false` znaczy „wycofany z katalogu", a
 * asystent nie ma prawa go zaproponować.
 */
export async function loadDigestRecipes(
  // `PrismaClient`, nie `PrismaService`: serwis go rozszerza, więc pasują oba —
  // i skrypt (goły klient) nie musi rzutować.
  prisma: PrismaClient,
  householdId: string,
): Promise<DigestRecipe[]> {
  const recipes = await prisma.recipe.findMany({
    where: { householdId, isActive: true },
    orderBy: [{ title: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      title: true,
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
          name: true,
          normalizedAmount: true,
          normalizedUnit: true,
          ingredient: { select: { gramsPerPiece: true } },
        },
      },
    },
  });

  return recipes.map((recipe) => ({
    ...recipe,
    ingredients: recipe.ingredients.map((item) => ({
      name: item.name,
      normalizedAmount: item.normalizedAmount,
      normalizedUnit: item.normalizedUnit,
      gramsPerPiece: item.ingredient.gramsPerPiece,
    })),
  }));
}
