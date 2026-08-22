import { MealType } from '@prisma/client';
import {
  MEAL_TYPES_IN_DAY_ORDER,
  effectiveSuitableMealTypes,
} from '../common/meal-types';

/**
 * Podpowiadanie, do których dodatkowych slotów nadaje się danie.
 *
 * Po co to w ogóle jest: II śniadanie i podwieczorek nie mają własnego
 * katalogu i nigdy nie powinny go mieć — to te same dania, tylko o innej
 * porze. Zamiast kazać komuś wprowadzać „Kanapka z twarożkiem (II śniadanie)"
 * drugi raz, każdy przepis niesie listę slotów, w których ma sens
 * (`Recipe.suitableMealTypes`). Ta funkcja jest tylko *podpowiedzią* pod
 * pierwsze wypełnienie tej listy i pod import — ostatnie słowo ma wartość
 * zapisana przy przepisie.
 *
 * Reguły są celowo zachowawcze: lepiej nie zaproponować pasującego dania,
 * niż wrzucić zapiekankę na podwieczorek. Wszystkie progi liczą się **na
 * porcję**, zgodnie z konwencją reszty projektu (makra w bazie opisują cały
 * przepis, `servings` mówi, na ile osób).
 *
 * Kolejność sprawdzania jest częścią kontraktu i wygląda tak:
 *
 *   1. dyskwalifikatory globalne (`DISQUALIFIER_MARKERS`) — jeśli trafią,
 *      danie nie dostaje **żadnego** dodatkowego slotu,
 *   2. progi kcal/czasu danej reguły,
 *   3. markery pozytywne reguły (musi trafić przynajmniej jeden),
 *   4. blokery reguły (`blockers`) — nie może trafić żaden.
 *
 * Krok 4 istnieje, bo sam marker pozytywny bywa niejednoznaczny: „twarożek"
 * jest słodki w naleśnikach i wytrawny w kanapce z ogórkiem. Bez blokera
 * jedno dwuznaczne słowo przepycha danie do reguły, z którą nie ma nic
 * wspólnego — patrz `suitable-meal-types.util.spec.ts`, sekcja o regresjach.
 */

export type SuitabilityInput = {
  title: string;
  description?: string | null;
  mealType: MealType;
  prepTimeMinutes: number;
  servings: number;
  nutritionKcal: number;
  suitableMealTypes?: MealType[] | null;
};

export type SuitabilitySuggestion = {
  mealType: MealType;
  reason: string;
};

/** Dania jednoznacznie obiadowo-kolacyjne — nie schodzą do przekąskowych slotów. */
const HEAVY_MARKERS = [
  'klopsik',
  'curry',
  'pieczon',
  'gulasz',
  'kotlet',
  'schabow',
  'stek',
  'żeberk',
  'zeberk',
  'risotto',
  'lasagne',
  'lazanie',
  'pierog',
  'bigos',
];

/** Zupy jako oddzielna kategoria — pasują na kolację, nie na przekąskę. */
const SOUP_MARKERS = ['zupa', 'krem z', 'rosół', 'rosol', 'żurek', 'zurek'];

/**
 * Sposób podania, a nie rodzaj dania. Osobna kategoria od `HEAVY_MARKERS`,
 * bo problem nie leży w tym, że danie jest ciężkie — tylko w tym, że trzeba
 * je zjeść od razu i na gorąco, więc do pudełka na II śniadanie się nie
 * nadaje, choćby mieściło się we wszystkich progach.
 *
 * Powód powstania listy: „Kanapki na ciepło z mozzarellą i pomidorem"
 * (456 kcal/porcja, 14 min) łapały marker `kanapk` i lądowały na II
 * śniadaniu. Zapiekana kanapka w pudełku do pracy to dokładnie ten przypadek,
 * którego te reguły miały nie produkować — a `HEAVY_MARKERS` go nie łapały,
 * bo opisują rzeczowniki („zapiekanka"), nie sposób podania („na ciepło").
 */
const SERVED_HOT_MARKERS = [
  'na ciepło',
  'na cieplo',
  'na gorąco',
  'na goraco',
  'zapiekan',
  'roztopion',
  'z piekarnika',
  'grillowan',
  'z patelni',
];

/** Cokolwiek z tej listy zamyka sprawę: żadnych dodatkowych slotów. */
const DISQUALIFIER_MARKERS = [
  ...HEAVY_MARKERS,
  ...SOUP_MARKERS,
  ...SERVED_HOT_MARKERS,
];

/** Dania, które w polskim rytmie dnia normalnie jada się „na drugie śniadanie”. */
const PORTABLE_MARKERS = [
  'kanapk',
  'tost',
  'tortill',
  'wrap',
  'jogurt',
  'musli',
  'owsiank',
  'twaro',
  'omlet',
  'jajecznic',
  'sałatk',
  'salatk',
  'placusz',
  'smoothie',
  'koktajl',
];

/**
 * Dodatkowo „podwieczorkowe”: słodsze / owocowe / deserowe.
 *
 * Świadomie **nie ma** tu `twaro`: twarożek sam z siebie nie jest słodki,
 * jest słodki dopiero z owocami albo miodem — a te mają tu własne wpisy.
 * Dopóki `twaro` było na liście, „Kanapka z twarożkiem i ogórkiem" jechała
 * na podwieczorek jako „lekkie / słodkie".
 */
const SWEET_MARKERS = [
  'jogurt',
  'musli',
  'owsiank',
  'placusz',
  'naleśnik',
  'nalesnik',
  'owoc',
  'jabłk',
  'jablk',
  'banan',
  'truskaw',
  'borówk',
  'borowk',
  'smoothie',
  'koktajl',
  'deser',
  'miod',
  'ciast',
];

/**
 * Sygnały wytrawne. Blokują wyłącznie regułę podwieczorku — przekąska i II
 * śniadanie mogą być wytrawne do woli, podwieczorek w tym projekcie znaczy
 * „coś lekkiego i słodkiego”.
 */
const SAVORY_MARKERS = [
  'ogórk',
  'ogork',
  'szynk',
  'wędlin',
  'wedlin',
  'feta',
  'szpinak',
  'szczypiorek',
  'pomidor',
  'papryk',
  'cebul',
  'tuńczyk',
  'tunczyk',
  'kurczak',
  'łosoś',
  'losos',
  'jajecznic',
  'awokado',
  'mizeri',
];

type Rule = {
  mealType: MealType;
  /** Górny limit kcal na porcję. */
  maxKcalPerServing: number;
  /** Górny limit czasu przygotowania. */
  maxPrepMinutes: number;
  /** Sloty bazowe, z których wolno awansować danie do tego slotu. */
  fromMealTypes: readonly MealType[];
  /** Przynajmniej jeden z tych markerów musi wystąpić w nazwie / opisie. */
  markers: readonly string[];
  /** Żaden z tych markerów nie może wystąpić — zawęża markery dwuznaczne. */
  blockers?: readonly string[];
  label: string;
};

/**
 * Progi wzięte z realnego rozkładu katalogu (patrz
 * `scripts/backfill-suitable-meal-types.ts --dry-run`), nie z sufitu:
 * śniadania mają 278–588 kcal/porcję, obiady 368–824, kolacje 352–832.
 * 480 kcal odcina naleśniki z twarożkiem i śniadaniową tortillę, 420 zostawia
 * na podwieczorek tylko rzeczy lekkie, a 350 — realne przekąski.
 */
const RULES: readonly Rule[] = [
  {
    mealType: MealType.SECOND_BREAKFAST,
    maxKcalPerServing: 480,
    maxPrepMinutes: 20,
    fromMealTypes: [MealType.BREAKFAST, MealType.DINNER],
    markers: PORTABLE_MARKERS,
    label: 'lekkie i przenośne',
  },
  {
    mealType: MealType.AFTERNOON_SNACK,
    maxKcalPerServing: 420,
    maxPrepMinutes: 25,
    fromMealTypes: [MealType.BREAKFAST, MealType.DINNER],
    markers: SWEET_MARKERS,
    blockers: SAVORY_MARKERS,
    label: 'lekkie / słodkie',
  },
  {
    mealType: MealType.SNACK,
    maxKcalPerServing: 350,
    maxPrepMinutes: 15,
    fromMealTypes: [MealType.BREAKFAST, MealType.DINNER],
    markers: [...PORTABLE_MARKERS, ...SWEET_MARKERS],
    label: 'mała i szybka',
  },
];

function haystack(input: SuitabilityInput): string {
  return `${input.title} ${input.description ?? ''}`.toLowerCase();
}

const MATCHER_CACHE = new Map<string, RegExp>();

/**
 * Markery są prefiksami, bo polski odmienia końcówki („kanapk” łapie kanapkę
 * i kanapki). Dlatego dopasowanie musi startować **na granicy słowa** —
 * gołe `includes` trafiało też w środek wyrazu, przez co np. `stek` łapał
 * „bifsztek”. `\b` nie wystarczy, bo nie zna polskich znaków; stąd lookbehind
 * na dowolną literę Unicode.
 */
function matcher(marker: string): RegExp {
  let regex = MATCHER_CACHE.get(marker);
  if (!regex) {
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    regex = new RegExp(`(?<!\\p{L})${escaped}`, 'iu');
    MATCHER_CACHE.set(marker, regex);
  }
  return regex;
}

function hasAny(text: string, markers: readonly string[]): boolean {
  return markers.some((marker) => matcher(marker).test(text));
}

function kcalPerServing(input: SuitabilityInput): number {
  const servings = Math.max(1, input.servings);
  return input.nutritionKcal / servings;
}

/**
 * Zwraca sloty, które warto **dołożyć** do przepisu, wraz z powodem.
 * Slot bazowy i sloty już zapisane nie wracają w wyniku.
 */
export function suggestExtraMealTypes(
  input: SuitabilityInput,
): SuitabilitySuggestion[] {
  const text = haystack(input);
  const already = new Set(effectiveSuitableMealTypes(input));

  // Ciężkie dania, zupy i wszystko, co je się na gorąco, zostaje tam, gdzie
  // jest. Zupa mieści się w limicie kcal (krem z pomidorów to 352 kcal/porcja),
  // a nikt nie je jej na drugie śniadanie z pudełka — dlatego osobny
  // odcinacz, nie próg.
  if (hasAny(text, DISQUALIFIER_MARKERS)) {
    return [];
  }

  const kcal = kcalPerServing(input);
  const suggestions: SuitabilitySuggestion[] = [];

  for (const rule of RULES) {
    if (already.has(rule.mealType)) continue;
    if (!rule.fromMealTypes.includes(input.mealType)) continue;
    if (kcal > rule.maxKcalPerServing) continue;
    if (input.prepTimeMinutes > rule.maxPrepMinutes) continue;
    if (!hasAny(text, rule.markers)) continue;
    if (rule.blockers && hasAny(text, rule.blockers)) continue;

    suggestions.push({
      mealType: rule.mealType,
      reason: `${rule.label}: ${Math.round(kcal)} kcal/porcja, ${input.prepTimeMinutes} min`,
    });
  }

  return suggestions;
}

/**
 * Pełna lista slotów dla przepisu po zastosowaniu podpowiedzi —
 * posortowana porą dnia, gotowa do zapisu w `suitableMealTypes`.
 */
export function resolveSuitableMealTypes(input: SuitabilityInput): MealType[] {
  const set = new Set(effectiveSuitableMealTypes(input));
  for (const suggestion of suggestExtraMealTypes(input)) {
    set.add(suggestion.mealType);
  }
  return MEAL_TYPES_IN_DAY_ORDER.filter((type) => set.has(type));
}
