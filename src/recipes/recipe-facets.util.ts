import { MealType } from '@prisma/client';
import { normalizeText } from '../common/normalize-text.util';

/**
 * Cechy przepisu do WYSZUKIWANIA — rodzaj dania, mięso, smak i trzy cechy
 * liczone z makro („szybkie", „lekkie", „dużo białka").
 *
 * Katalog nie niesie tagów (`sourceCategory`, `sourceCuisine`, `sourceTags`
 * są puste we wszystkich 500 przepisach), więc cechy liczą się z NAZWY dania
 * i składników — tymi samymi regułami, co filtry kategorii w iOS
 * (`RecipeCategoryFacets.swift`, sprawdzone na 495 przepisach 23.09.2026).
 * Różnice wobec iOS są dwie i obie celowe:
 *
 * 1. Jeden słownik zamiast czterech. W iOS „bake" znaczy w kolacji zapiekankę,
 *    a w przekąskach ciasto, bo każda kategoria ma własny arkusz. Asystent
 *    szuka przez wszystkie pory naraz, więc ciasto to `cake`, zapiekanka
 *    `bake`, a „kanapki i tosty" ze śniadań i „kanapki i wrapy" z kolacji to
 *    jedno `sandwich`. Makaron w kolacji nie zlewa się z kaszą (`pasta` ≠ `grains`).
 * 2. Dochodzą cechy z makro na porcję — progi niżej, przy stałych.
 *
 * Danie, którego nie da się uczciwie przypisać, NIE dostaje rodzaju: wypada
 * przy zawężeniu po rodzaju, ale zostaje, gdy rodzaj jest dowolny (jak w iOS).
 *
 * Czyste funkcje bez bazy: liczone raz na przepis przy budowie indeksu
 * wyszukiwania asystenta (`src/agent/search/`).
 */

export const RECIPE_DISH_TAGS = [
  'soup',
  'salad',
  'pasta',
  'grains',
  'potatoes',
  'dumplings',
  'stew',
  'porridge',
  'eggs',
  'sandwich',
  'pancakes',
  'yogurt',
  'bake',
  'cake',
  'dessert',
  'crunchy',
  'bites',
  'dip',
  'drink',
] as const;
export type RecipeDishTag = (typeof RECIPE_DISH_TAGS)[number];

export const RECIPE_PROTEIN_TAGS = [
  'poultry',
  'pork',
  'beef',
  'fish',
  'meatless',
] as const;
export type RecipeProteinTag = (typeof RECIPE_PROTEIN_TAGS)[number];

export const RECIPE_TASTE_TAGS = ['sweet', 'savory'] as const;
export type RecipeTasteTag = (typeof RECIPE_TASTE_TAGS)[number];

export const RECIPE_TRAIT_TAGS = ['quick', 'light', 'high_protein'] as const;
export type RecipeTraitTag = (typeof RECIPE_TRAIT_TAGS)[number];

export const RECIPE_SEARCH_TAGS = [
  ...RECIPE_DISH_TAGS,
  ...RECIPE_PROTEIN_TAGS,
  ...RECIPE_TASTE_TAGS,
  ...RECIPE_TRAIT_TAGS,
] as const;
export type RecipeSearchTag = (typeof RECIPE_SEARCH_TAGS)[number];

export type RecipeTagGroup = 'dish' | 'protein' | 'taste' | 'trait';

/** Do której grupy należy tag — w obrębie grupy filtr łączy LUB, między grupami I. */
export function tagGroup(tag: RecipeSearchTag): RecipeTagGroup {
  if ((RECIPE_DISH_TAGS as readonly string[]).includes(tag)) return 'dish';
  if ((RECIPE_PROTEIN_TAGS as readonly string[]).includes(tag)) {
    return 'protein';
  }
  if ((RECIPE_TASTE_TAGS as readonly string[]).includes(tag)) return 'taste';
  return 'trait';
}

export function isRecipeSearchTag(value: unknown): value is RecipeSearchTag {
  return (
    typeof value === 'string' &&
    (RECIPE_SEARCH_TAGS as readonly string[]).includes(value)
  );
}

/**
 * Polska nazwa tagu i słowa, po których ten tag łapie się w zapytaniu
 * tekstowym. Etykieta idzie do mapy katalogu w prompcie, synonimy — do tekstu,
 * po którym szuka wyszukiwarka: „coś lekkiego" trafia w `light`, „zupka"
 * w `soup`, bez osobnego słownika synonimów.
 */
export const RECIPE_TAG_LABELS: Record<
  RecipeSearchTag,
  { label: string; words: string }
> = {
  soup: { label: 'zupy i kremy', words: 'zupa zupka zupy krem' },
  salad: { label: 'sałatki', words: 'salatka salatki' },
  pasta: { label: 'makarony', words: 'makaron makarony pasta' },
  grains: { label: 'z ryżem lub kaszą', words: 'ryz kasza kasze' },
  potatoes: { label: 'z ziemniakami', words: 'ziemniaki ziemniakami' },
  dumplings: {
    label: 'pierogi, kluski, placki ziemniaczane',
    words: 'pierogi kluski kopytka',
  },
  stew: { label: 'gulasze, curry, potrawki', words: 'gulasz curry potrawka' },
  porridge: {
    label: 'owsianki, jaglanki, kasze na słodko',
    words: 'owsianka jaglanka',
  },
  eggs: { label: 'jajka i omlety', words: 'jajka jajecznica omlet' },
  sandwich: {
    label: 'kanapki, tosty, wrapy',
    words: 'kanapka kanapki tost wrap',
  },
  pancakes: {
    label: 'placki, naleśniki, gofry',
    words: 'placki nalesniki pancakes',
  },
  yogurt: {
    label: 'jogurty, twarożki, smoothie bowl',
    words: 'jogurt twarozek',
  },
  bake: {
    label: 'zapiekanki i pizza',
    words: 'zapiekanka pizza z piekarnika',
  },
  cake: { label: 'ciasta i wypieki', words: 'ciasto ciasta wypieki' },
  dessert: {
    label: 'desery na łyżkę',
    words: 'deser desery pudding budyn',
  },
  crunchy: { label: 'chrupiące przekąski', words: 'chrupiace chipsy' },
  bites: { label: 'małe przekąski', words: 'przekaska przekaski' },
  dip: { label: 'dipy i pasty', words: 'dip pasta hummus' },
  drink: { label: 'koktajle', words: 'koktajl smoothie shake' },
  poultry: { label: 'drób', words: 'drob kurczak indyk' },
  pork: { label: 'wieprzowina', words: 'wieprzowina schab' },
  beef: { label: 'wołowina', words: 'wolowina' },
  fish: { label: 'ryby i owoce morza', words: 'ryba ryby owoce morza' },
  meatless: {
    label: 'bez mięsa i ryb',
    words: 'wegetarianskie bez miesa jarskie',
  },
  sweet: { label: 'na słodko', words: 'slodkie na slodko' },
  savory: { label: 'na słono', words: 'slone wytrawne na wytrawnie' },
  quick: {
    label: 'szybkie (do 20 min)',
    words: 'szybkie szybko ekspresowe',
  },
  light: {
    label: 'lekkie (do 400 kcal na porcję)',
    words: 'lekkie lekki dietetyczne',
  },
  high_protein: {
    label: 'dużo białka (min. 25 g na porcję)',
    words: 'bialko bialkowe proteinowe',
  },
};

/** „Szybkie" = do 20 minut przygotowania; 0 minut znaczy „nie wiemy", nie „od ręki". */
export const QUICK_MAX_PREP_MINUTES = 20;
/** „Lekkie" = do 400 kcal na porcję (i więcej niż 0 — zero to brak makr). */
export const LIGHT_MAX_KCAL_PER_SERVING = 400;
/** „Dużo białka" = co najmniej 25 g na porcję. */
export const HIGH_PROTEIN_MIN_GRAMS_PER_SERVING = 25;

export type FacetIngredient = {
  name: string;
  /** Dział sklepu (`RecipeIngredient.department`): „Mięso", „Ryby", „Owoce"… */
  department: string;
};

export type FacetRecipe = {
  title: string;
  mealType: MealType;
  prepTimeMinutes: number;
  /** Makro NA PORCJĘ; `null` = przepis bez makr. */
  perServing: { kcal: number; protein: number } | null;
  ingredients: readonly FacetIngredient[];
};

type Category = 'breakfast' | 'lunch' | 'dinner' | 'snacks';

function categoryOf(mealType: MealType): Category {
  switch (mealType) {
    case 'BREAKFAST':
      return 'breakfast';
    case 'LUNCH':
      return 'lunch';
    case 'DINNER':
      return 'dinner';
    default:
      return 'snacks';
  }
}

type DishTable = readonly (readonly [RecipeDishTag, readonly string[]])[];

// Tabele przeniesione z `RecipeCategoryFacets.swift` — spacja na początku
// słowa kluczowego to granica wyrazu (tytuł jest otoczony spacjami).
const BREAKFAST_DISHES: DishTable = [
  [
    'porridge',
    [
      ' owsiank',
      ' jaglank',
      ' kasza',
      ' kasze',
      ' ryz na mleku',
      ' musli',
      ' kuskus',
      ' zupa mleczna',
      ' granol',
    ],
  ],
  [
    'eggs',
    [
      ' jajecznic',
      ' omlet',
      ' jajk',
      ' frittat',
      ' szakszuk',
      ' tofucznic',
      ' sniadanie po angielsku',
    ],
  ],
  [
    'sandwich',
    [
      ' kanapk',
      ' tost',
      ' grzank',
      ' bulecz',
      ' bulka',
      ' bajgiel',
      ' wrap',
      ' tortill',
      ' rogalik',
      ' pasta ',
      ' chleb',
      ' zapiekanka chlebowa',
      ' parowk',
      ' pieczarki na toscie',
    ],
  ],
  [
    'pancakes',
    [
      ' placusz',
      ' placki',
      ' nalesnik',
      ' pancake',
      ' racuch',
      ' gofr',
      ' syrnik',
      ' leniwe',
      ' serniczki',
    ],
  ],
  [
    'yogurt',
    [
      ' jogurt',
      ' skyr',
      ' twaroz',
      ' serek',
      ' parfait',
      ' smoothie',
      ' pudding',
    ],
  ],
];

const LUNCH_DISHES: DishTable = [
  [
    'soup',
    [
      ' zupa',
      ' krem z',
      ' rosol',
      ' barszcz',
      ' zurek',
      ' kapusniak',
      ' grochowk',
      ' kartoflank',
      ' krupnik',
      ' minestrone',
      ' chlodnik',
      ' gazpacho',
    ],
  ],
  [
    'dumplings',
    [
      ' pierog',
      ' kopytk',
      ' klusk',
      ' knedl',
      ' lazank',
      ' gnocchi',
      ' placki ziemniaczane',
      ' placki po wegiersku',
      ' krokiet',
    ],
  ],
  [
    'pasta',
    [
      ' makaron',
      ' spaghetti',
      ' penne',
      ' tagliatelle',
      ' lasagne',
      ' cannelloni',
      ' tortellini',
      ' mac and cheese',
      ' udon',
    ],
  ],
  ['salad', [' salatk', ' tabbouleh']],
  [
    'stew',
    [
      ' gulasz',
      ' curry',
      ' leczo',
      ' bigos',
      ' chili ',
      ' strogonow',
      ' potrawk',
      ' paprykarz',
      ' tikka',
      ' po bretonsku',
      ' kung pao',
    ],
  ],
];

const DINNER_DISHES: DishTable = [
  ['salad', [' salatk', ' tabbouleh']],
  ['soup', [' zupa', ' krem z', ' chlodnik', ' gazpacho']],
  [
    'sandwich',
    [
      ' kanapk',
      ' wrap',
      ' tortill',
      ' quesadill',
      ' burrito',
      ' taco',
      ' fajit',
      ' enchilad',
      ' pita ',
      ' panini',
      ' tost',
      ' bruschett',
      ' grzank',
      ' burger',
      ' hot dog',
      ' pulled pork',
      ' sajgonk',
      ' gofry',
    ],
  ],
  [
    'bake',
    [
      ' pizz',
      ' calzone',
      ' lahmacun',
      ' focaccia',
      ' zapiek',
      ' gratin',
      ' parmigiana',
      ' faszerowan',
    ],
  ],
];

const SNACK_DISHES: DishTable = [
  ['drink', [' koktajl', ' smoothie', ' lemoniad', ' shake']],
  [
    'dessert',
    [
      ' pudding',
      ' budyn',
      ' kisiel',
      ' panna cotta',
      ' tiramisu',
      ' mus ',
      ' lody',
      ' deser',
      ' pucharek',
      ' galaretk',
      ' parfait',
      ' salatka owocowa',
      ' pieczone jablka',
    ],
  ],
  [
    'cake',
    [
      ' ciast',
      ' ciesc',
      ' sernik',
      ' brownie',
      ' blondie',
      ' babka',
      ' murzynek',
      ' szarlotk',
      ' muffin',
      ' piernik',
      ' tarta',
      ' cynamonk',
      ' rogalik',
      ' chlebek',
      ' kokosank',
      ' crumble',
      ' wisniowiec',
      ' blok ',
      ' batonik',
      ' kulki',
      ' bulecz',
      ' pizz',
      ' chleb ',
      ' pierozk',
      ' krakers',
    ],
  ],
  [
    'dip',
    [
      ' hummus',
      ' guacamole',
      ' tzatziki',
      ' pasta z',
      ' salsa',
      ' dipem z',
      ' dip ',
    ],
  ],
  [
    'crunchy',
    [
      ' chips',
      ' fryt',
      ' paluszk',
      ' nachos',
      ' krazk',
      ' prazon',
      ' skrzydel',
      ' orzech',
      ' edamame',
    ],
  ],
  [
    'bites',
    [
      ' mini ',
      ' klops',
      ' roladk',
      ' koreczk',
      ' szaszl',
      ' jajka faszerowane',
      ' slimaczk',
      ' wrap',
      ' kurczak',
      ' salatka z',
      ' camembert',
      ' jajka',
    ],
  ],
];

/** Dania z garnkiem na zapleczu: ryż i kasze w nazwie. */
const GRAIN_TITLES = [
  ' risotto',
  ' pilaw',
  ' kaszotto',
  ' paella',
  ' peczotto',
  ' bowl',
];

/**
 * Rodzaj dania to zwykle pierwszy rzeczownik nazwy: „Tost z jajkiem" to
 * kanapka, „Jajka na miękko z grzankami" — jajka. Wygrywa słowo kluczowe,
 * które stoi w nazwie NAJWCZEŚNIEJ, a nie to, które stoi wyżej w tabeli.
 */
function firstMatch(title: string, table: DishTable): RecipeDishTag | null {
  let best: RecipeDishTag | null = null;
  let bestOffset = Number.POSITIVE_INFINITY;
  for (const [kind, words] of table) {
    for (const word of words) {
      const offset = title.indexOf(word);
      if (offset >= 0 && offset < bestOffset) {
        best = kind;
        bestOffset = offset;
      }
    }
  }
  return best;
}

type FoldedIngredient = { name: string; department: string };

const containsAny = (text: string, words: readonly string[]): boolean =>
  words.some((word) => text.includes(word));

function sides(ingredients: readonly FoldedIngredient[]): {
  grains: boolean;
  potatoes: boolean;
  pasta: boolean;
} {
  let grains = false;
  let potatoes = false;
  let pasta = false;
  for (const { name } of ingredients) {
    if (
      name.startsWith('makaron') ||
      containsAny(name, ['spaghetti', 'gnocchi', 'tortellini'])
    ) {
      pasta = true;
    }
    // „kaszanka" zaczyna się od „kasza", a kaszą nie jest.
    if (
      name.startsWith('ryz') ||
      name === 'kasza' ||
      name.startsWith('kasza ') ||
      containsAny(name, ['kuskus', 'bulgur', 'peczak', 'komosa', 'quinoa'])
    ) {
      grains = true;
    }
    if (name.startsWith('ziemniak') || name.startsWith('frytk')) {
      potatoes = true;
    }
  }
  return { grains, potatoes, pasta };
}

function dishOf(
  category: Category,
  title: string,
  ingredients: readonly FoldedIngredient[],
): RecipeDishTag | null {
  switch (category) {
    case 'breakfast':
      return firstMatch(title, BREAKFAST_DISHES);
    case 'snacks':
      return firstMatch(title, SNACK_DISHES);
    case 'lunch': {
      const dish = firstMatch(title, LUNCH_DISHES);
      if (dish) return dish;
      if (containsAny(title, GRAIN_TITLES)) return 'grains';
      const side = sides(ingredients);
      if (side.pasta) return 'pasta';
      if (side.grains) return 'grains';
      if (side.potatoes) return 'potatoes';
      return null;
    }
    case 'dinner': {
      const dish = firstMatch(title, DINNER_DISHES);
      if (dish) return dish;
      if (containsAny(title, GRAIN_TITLES)) return 'grains';
      const side = sides(ingredients);
      // Inaczej niż w iOS: tam „Makaron, ryż, kasze" to jedna pigułka
      // kolacji, tu makaron jest makaronem w każdej porze.
      if (side.pasta) return 'pasta';
      if (side.grains) return 'grains';
      if (side.potatoes) return 'potatoes';
      return null;
    }
  }
}

const POULTRY_WORDS = [
  'kurczak',
  'indyk',
  'drob',
  'kacz',
  'udko',
  'podudzie',
  'skrzydel',
];
const PORK_WORDS = [
  'wieprz',
  'schab',
  'karkow',
  'zeberk',
  'boczek',
  'kielbas',
  'szynk',
  'golonk',
  'kaszank',
  'salami',
  'parowk',
  'skwark',
  'chorizo',
  'slonin',
  'smalec',
  'pancett',
  'bekon',
];
const BEEF_WORDS = ['wolow', 'stek', 'antrykot', 'rostbef', 'cielec'];
const FISH_WORDS = [
  'losos',
  'dorsz',
  'mintaj',
  'pstrag',
  'makrel',
  'tunczyk',
  'sardyn',
  'krewet',
  'sledz',
  'halibut',
  'tilapi',
  'owoce morza',
  'kalmar',
  'malz',
];

const DEPARTMENT_MEAT = 'mieso';
const DEPARTMENT_FISH = 'ryby';
const DEPARTMENT_FRUITS = 'owoce';

function proteinsOf(
  ingredients: readonly FoldedIngredient[],
): RecipeProteinTag[] {
  const result = new Set<RecipeProteinTag>();
  for (const { name, department } of ingredients) {
    if (containsAny(name, POULTRY_WORDS)) {
      result.add('poultry');
    } else if (
      containsAny(name, PORK_WORDS) ||
      // „polędwica z indyka" to wędlina drobiowa — łapie ją gałąź wyżej.
      (name.startsWith('poledwic') && !name.includes('indyk'))
    ) {
      result.add('pork');
    }
    if (containsAny(name, BEEF_WORDS)) result.add('beef');
    if (department === DEPARTMENT_FISH || containsAny(name, FISH_WORDS)) {
      result.add('fish');
    }
  }
  // „Bez mięsa i ryb" tylko na dowodzie: przepis bez składników nie jest
  // wegetariański, tylko nieznany.
  if (result.size === 0 && ingredients.length > 0) result.add('meatless');
  return RECIPE_PROTEIN_TAGS.filter((tag) => result.has(tag));
}

const SWEET_WORDS = [
  'cukier',
  'miod',
  'syrop',
  'dzem',
  'kakao',
  'czekolad',
  'budyn',
  'galaretk',
  'biszkopt',
  'herbatnik',
  'cynamon',
  'rodzyn',
  'wanili',
  'mascarpone',
  'granol',
  'maslo orzechowe',
  'nutell',
  'powidl',
  'konfitur',
  'bita smietan',
  'smietanka 30',
  'daktyl',
  'zurawin',
  'kisiel',
];
const SAVORY_WORDS = [
  'cebul',
  'czosnek',
  'szczypior',
  'natka',
  'koperek',
  'pieprz',
  'pomidor',
  'papryka',
  'ogorek',
  'rzodkiew',
  'szpinak',
  'pieczark',
  'musztard',
  'majonez',
  'ketchup',
  'sos sojow',
  'oliwk',
  'rukol',
  'salat',
  'por',
  'kapust',
  'brokul',
  'cukini',
  'fasol',
  'ciecierzyc',
  'soczewic',
  'kukurydz',
  'awokado',
  'hummus',
  'chili',
  'kmin',
  'oregano',
  'bazyli',
  'tymianek',
  'majeranek',
  'curry',
];
const CHEESE_WORDS = [
  'ser zolty',
  'feta',
  'parmezan',
  'mozzarell',
  'gouda',
  'cheddar',
  'camembert',
  'halloumi',
  'gorgonzol',
  'ser plesniow',
  'ser kozi',
];
const SOUR_FRUIT = ['cytryn', 'limonk', 'awokado'];

/**
 * Słodkie kontra słone — jawne „na słodko" / „na wytrawnie" w nazwie
 * rozstrzyga od razu, w pozostałych przypadkach ważą składniki: mięso i ryby
 * mocno, owoce i cukier średnio, warzywa, sery i zioła lekko. Remis idzie na
 * stronę słoną — bezpieczniejszą pomyłką jest kanapka wśród słonych niż
 * deser wśród obiadów.
 */
function tasteOf(
  title: string,
  ingredients: readonly FoldedIngredient[],
): RecipeTasteTag {
  if (title.includes('na slodko')) return 'sweet';
  if (title.includes('wytrawn')) return 'savory';
  let sweet = 0;
  let savory = 0;
  for (const { name, department } of ingredients) {
    if (department === DEPARTMENT_MEAT || department === DEPARTMENT_FISH) {
      savory += 3;
    }
    if (department === DEPARTMENT_FRUITS && !containsAny(name, SOUR_FRUIT)) {
      sweet += 2;
    }
    if (containsAny(name, SWEET_WORDS)) sweet += 2;
    if (containsAny(name, SAVORY_WORDS)) savory += 1;
    if (containsAny(name, CHEESE_WORDS)) savory += 2;
    if (name === 'jajko') savory += 0.5;
  }
  return sweet > savory ? 'sweet' : 'savory';
}

function traitsOf(recipe: FacetRecipe): RecipeTraitTag[] {
  const traits: RecipeTraitTag[] = [];
  if (
    recipe.prepTimeMinutes > 0 &&
    recipe.prepTimeMinutes <= QUICK_MAX_PREP_MINUTES
  ) {
    traits.push('quick');
  }
  const perServing = recipe.perServing;
  if (
    perServing &&
    perServing.kcal > 0 &&
    perServing.kcal <= LIGHT_MAX_KCAL_PER_SERVING
  ) {
    traits.push('light');
  }
  if (perServing && perServing.protein >= HIGH_PROTEIN_MIN_GRAMS_PER_SERVING) {
    traits.push('high_protein');
  }
  return traits;
}

/**
 * Wszystkie tagi przepisu w kolejności słownika (`RECIPE_SEARCH_TAGS`),
 * więc wynik jest deterministyczny — indeks i mapa katalogu liczą się bajt
 * w bajt tak samo przy każdym uruchomieniu.
 */
export function recipeSearchTags(recipe: FacetRecipe): RecipeSearchTag[] {
  const title = ` ${normalizeText(recipe.title)} `;
  const ingredients: FoldedIngredient[] = recipe.ingredients.map(
    (ingredient) => ({
      name: normalizeText(ingredient.name),
      department: normalizeText(ingredient.department ?? ''),
    }),
  );
  const tags = new Set<RecipeSearchTag>();
  const dish = dishOf(categoryOf(recipe.mealType), title, ingredients);
  if (dish) tags.add(dish);
  for (const protein of proteinsOf(ingredients)) tags.add(protein);
  tags.add(tasteOf(title, ingredients));
  for (const trait of traitsOf(recipe)) tags.add(trait);
  return RECIPE_SEARCH_TAGS.filter((tag) => tags.has(tag));
}
