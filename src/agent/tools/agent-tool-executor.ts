import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/app-exception';
import { mapError } from '../../common/error-contract';
import { HouseholdsService } from '../../households/households.service';
import { IngredientsService } from '../../recipes/ingredients.service';
import { RecipesService } from '../../recipes/recipes.service';
import {
  ApplyWeekPlanDto,
  ApplyWeekSlotDto,
} from '../../weekly-plans/dto/apply-week-plan.dto';
import {
  ApplyWeekPlanResult,
  WeeklyPlansService,
} from '../../weekly-plans/weekly-plans.service';
import { AgentMetricsService } from '../../observability/agent-metrics.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentMemoryService } from '../agent-memory.service';
import { AiUsageCountersService } from '../ai-usage-counters.service';
import { CreateRecipeDto } from '../../recipes/dto/create-recipe.dto';
import { UpdateRecipeDto } from '../../recipes/dto/update-recipe.dto';
import { EXECUTABLE_TOOL_NAMES } from './agent-tools';
import { memoized, TURN_KEYS, TurnMemo } from '../turn-memo';
import {
  checkPlanScope,
  PlanScope,
  PlanScopeDates,
  recordPlannedDays,
} from './plan-scope';
import {
  AgentProposalsService,
  CreateWeekProposalResult,
} from '../proposals/agent-proposals.service';
import { AgentCard, PlanRemovalReason } from '../cards/agent-cards';
import { AgentPromptService } from '../agent-prompt.service';
import {
  projectWeekPlanForModel,
  WeekPlanForModel,
} from '../week-plan-projection';

// Projekcja mieszka obok promptu, bo czyta ją też `AgentPromptService`
// (plan planowanego tygodnia w bloku gospodarstwa); stąd dalej się eksportuje.
export {
  projectWeekPlanForModel,
  type WeekPlanForModel,
  type WeekPlanItemForModel,
} from '../week-plan-projection';
import { buildClarifyCard, MAX_CLARIFY_OPTIONS } from '../cards/clarify-card';
import {
  buildOptionsCard,
  MAX_OPTIONS,
  optionPrompt,
} from '../cards/options-card';
import {
  MacroGapBooster,
  MacroKey,
  MEAL_LABELS,
  DAY_LABELS,
  OptionsCardItem,
  SwapCardSide,
} from '../cards/agent-cards';
import { buildMacroGapCard, MAX_BOOSTERS } from '../cards/macro-gap-card';
import { buildShoppingListCard } from '../cards/shopping-list-card';
import { ShoppingListService } from '../../weekly-plans/services/shopping-list.service';
import { WeeklyPlansGateway } from '../../weekly-plans/weekly-plans.gateway';
import { SetMealEatenDto } from '../../weekly-plans/dto/set-meal-eaten.dto';
import { UpdateShoppingItemCheckDto } from '../../weekly-plans/dto/update-shopping-item-check.dto';
import { ShoppingDepartment } from '../../weekly-plans/types/shopping-department.enum';
import { DayOfWeek, DietPreferenceValue, MealType } from '@prisma/client';
import {
  AgentMealPlannerService,
  plannerResultForModel,
  PlannerWishes,
} from '../planner/agent-meal-planner.service';
import { normalizeText } from '../../common/normalize-text.util';
import { searchStem } from '../../recipes/ingredient-search.util';
import { isRecipeSearchTag } from '../../recipes/recipe-facets.util';
import {
  AgentCatalogService,
  AgentSearchResult,
} from '../search/agent-catalog.service';
import {
  RecipeSearchQuery,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_SORTS,
  SearchSort,
} from '../search/catalog-search';

/**
 * Kontekst tury: kto pyta i o które gospodarstwo.
 *
 * Model NIE dostaje tych wartości i nie może ich podać — bierzemy je z tury,
 * dokładnie tak, jak handlery WS biorą tożsamość z socketu, a nie z payloadu.
 * Gdyby `household_id` był polem narzędzia, wystarczyłoby, żeby model je
 * zmyślił, i asystent pisałby po cudzym planie.
 */
/**
 * Naruszenia planu wracają do MODELU bez listy alergenów i wykluczeń: model
 * ma wybrać inne danie, a nie poznać, na co uczulony jest domownik bez zgody
 * (polityka §6). Kod naruszenia zostaje — po nim model wie, co poprawić.
 *
 * REDAKCJA IDZIE ZA KSZTAŁTEM, NIE ZA NAZWĄ POLA. Szukamy obiektu, który ma
 * `code` z tabeli niżej i `message` — gdziekolwiek w wyniku by nie siedział.
 *
 * Wcześniej ta funkcja rozpoznawała wyłącznie pole o nazwie `violations`
 * i to była PRZYCZYNA wycieku z 7.09.2026: `check_plan_conflicts` nazywał je
 * `conflicts`, więc komunikat „Danie zawiera alergeny domownika: LACTOSE,
 * GLUTEN." przechodził nietknięty do modelu, a stamtąd do odpowiedzi — także
 * dla domownika, który NIGDY nie zgodził się na asystenta. Samo ujednolicenie
 * nazwy naprawiło ten jeden przypadek i zostawiło klasę błędu: następne
 * narzędzie z polem `problems` albo `issues` przeciekłoby tak samo, a jedyną
 * obroną byłby komentarz. Komentarz nie jest bramką, więc nazwa pola przestała
 * mieć znaczenie dla bezpieczeństwa.
 */
const REDACTED_VIOLATION_MESSAGES: Record<string, string> = {
  RECIPE_ALLERGEN_CONFLICT:
    'Danie zawiera alergen któregoś z jedzących — wybierz inne danie na ten slot.',
  RECIPE_EXCLUDED_INGREDIENT:
    'Danie zawiera składnik, którego ktoś z jedzących nie je — wybierz inne danie.',
};

/**
 * Sufit zagnieżdżenia. Wyniki narzędzi to zwykły JSON z serwisów (bez cykli),
 * więc to nie jest ochrona przed pętlą, tylko przed kosztem: gdyby kiedyś
 * wpadł tu wynik o nieoczekiwanej głębokości, redakcja ma się zatrzymać,
 * a nie chodzić po całym grafie.
 */
const MAX_REDACTION_DEPTH = 8;

/** Zredagowany komunikat dla tego obiektu albo `null`, gdy go nie dotyczy. */
function redactedMessageFor(record: Record<string, unknown>): string | null {
  const { code, message } = record;
  if (typeof code !== 'string' || typeof message !== 'string') return null;
  return REDACTED_VIOLATION_MESSAGES[code] ?? null;
}

/**
 * Zwraca TĘ SAMĄ referencję, gdy nic nie wymagało redakcji — dzięki temu
 * wynik bez naruszeń (czyli zdecydowana większość) nie kosztuje ani jednej
 * alokacji, a testy mogą sprawdzać brak zmian tożsamością.
 */
function redactNode(node: unknown, depth: number): unknown {
  if (
    depth > MAX_REDACTION_DEPTH ||
    node === null ||
    typeof node !== 'object'
  ) {
    return node;
  }

  if (Array.isArray(node)) {
    let changed = false;
    const next = node.map((entry) => {
      const redacted = redactNode(entry, depth + 1);
      if (redacted !== entry) changed = true;
      return redacted;
    });
    return changed ? next : node;
  }

  const record = node as Record<string, unknown>;
  const replacement = redactedMessageFor(record);
  let next: Record<string, unknown> | null =
    replacement === null ? null : { ...record, message: replacement };

  for (const [key, value] of Object.entries(record)) {
    // `message` już podmieniony — schodzenie w nie miałoby co poprawić.
    if (key === 'message' && replacement !== null) continue;
    const redacted = redactNode(value, depth + 1);
    if (redacted !== value) {
      next = next ?? { ...record };
      next[key] = redacted;
    }
  }

  return next ?? node;
}

export function redactViolationsForModel<T>(result: T): T {
  return redactNode(result, 0) as T;
}

/**
 * Wynik zapisu tygodnia w kształcie dla modelu.
 *
 * `plan` przechodzi przez tę samą projekcję, co `get_week_plan`. Zmierzone
 * 7.09.2026: wynik `apply_week_plan` po zapisie 21 pozycji ważył 99 581 B,
 * z czego 99 477 B (99,9 %) to było pole `plan` — pełna encja z listą
 * składników każdego dania, `imageUrl`, `authorId` i znacznikami czasu.
 * Model dostawał z powrotem ~33 tys. tokenów opisujących stan, KTÓRY SAM
 * przed chwilą wysłał. A że w produkcji `AI_CARDS_MODE=off`, to jest GŁÓWNA
 * ścieżka zapisu planu — czyli najdroższa tura płaciła ten rachunek za
 * każdym razem.
 *
 * Pola nie usuwamy, tylko chudzimy: potwierdzenie ma dalej pochodzić z BAZY
 * po transakcji, a nie z pamięci modelu o tym, co wysłał. To ta sama reguła,
 * co przy kartach („liczby liczy serwer, model cytuje").
 */
export type ApplyWeekPlanForModel = Omit<ApplyWeekPlanResult, 'plan'> & {
  plan: WeekPlanForModel | null;
};

/**
 * Przepis po zapisie — POTWIERDZENIE, nie encja.
 *
 * `create_recipe` i `update_recipe` oddawały modelowi cały wiersz z bazy:
 * 1 299 B i 1 184 B (pomiar 7.09.2026), z czego 362 B to sam `imageUrl`.
 * Model nie ma co zrobić z adresem zdjęcia — ale MA gdzie go wkleić, bo
 * pisze odpowiedź użytkownikowi. Zostaje to, po co się tu przychodzi:
 * identyfikator do dalszej pracy i MAKRA POLICZONE PRZEZ SERWER, bo to
 * jedyna liczba, której model nie ma prawa podać sam.
 */
export type RecipeForModel = {
  id: string;
  title: string;
  mealType: string;
  servings: number;
  prepTimeMinutes: number;
  kcalPerServing: number;
  allergens: string[];
  dietTags: string[];
  /** Ile składników zapisał serwer — po tym model pozna, że coś wypadło. */
  ingredientCount: number;
};

export function projectRecipeForModel(recipe: {
  id: string;
  title: string;
  mealType: string;
  servings: number | null;
  prepTimeMinutes: number | null;
  nutritionKcal: number | null;
  allergens: string[];
  dietTags: string[];
  ingredients?: unknown[];
}): RecipeForModel {
  const servings = Math.max(1, recipe.servings ?? 1);
  return {
    id: recipe.id,
    title: recipe.title,
    mealType: recipe.mealType,
    servings,
    prepTimeMinutes: recipe.prepTimeMinutes ?? 0,
    kcalPerServing: Math.round((recipe.nutritionKcal ?? 0) / servings),
    allergens: recipe.allergens,
    dietTags: recipe.dietTags,
    ingredientCount: recipe.ingredients?.length ?? 0,
  };
}

/**
 * Pełny przepis dla modelu — jedyne miejsce, w którym widzi CAŁY skład.
 *
 * Katalog w prompcie niesie pięć najcięższych składników na danie (patrz
 * `catalog-digest.ts`) i to jest świadomy kompromis kosztowy, ale ma cenę:
 * model NIE MA jak odpowiedzieć na „jak to ugotować" ani „czy jest w tym
 * masło", a pytany z pamięci zgaduje. Instrukcja zabrania mu zgadywać, więc
 * bez tego narzędzia odpowiedzią było „nie wiem" na najczęstsze pytanie
 * o jedzenie, jakie da się zadać.
 *
 * Dlaczego to nie jest zwykłe oddanie wiersza z bazy: `imageUrl` (362 B),
 * `sourceMeta`, `isFavorite` i identyfikatory składników nie służą tu do
 * niczego, a model MA gdzie je wkleić, bo pisze tekst użytkownikowi.
 * Zostaje skład po ludzku i kroki.
 *
 * Makra idą NA PORCJĘ, tak samo jak w digeście — w bazie opisują cały przepis
 * (CLAUDE.md, „Makro = cały przepis"), a model i użytkownik myślą porcjami.
 */
export const DETAILS_MAX_INGREDIENTS = 60;
export const DETAILS_MAX_STEPS = 40;

export type RecipeDetailsForModel = {
  id: string;
  title: string;
  mealType: string;
  servings: number;
  prepTimeMinutes: number;
  kcalPerServing: number;
  proteinPerServing: number;
  fatPerServing: number;
  carbsPerServing: number;
  allergens: string[];
  dietTags: string[];
  /** Cały skład: nazwa, ilość i jednostka tak, jak widzi je użytkownik. */
  ingredients: { name: string; amount: number; unit: string }[];
  /** Kroki po kolei; pusta lista = przepis ich po prostu nie ma. */
  steps: string[];
  /** `true` = przepis ze WSPÓLNEGO katalogu, więc nie da się go zmienić. */
  isCatalog: boolean;
};

/**
 * Kroki bywają zapisane trzema pisowniami, bo katalog jest starszy niż
 * `recipes:create` ze krokami (patrz `recipe-steps.util.ts`). Czytamy je
 * tolerancyjnie i po kolei — model dostaje tablicę zdań, a nie kształt JSON-a.
 */
export function readRecipeSteps(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index) => {
      if (typeof entry === 'string') return { order: index + 1, text: entry };
      const row = (entry ?? {}) as Record<string, unknown>;
      const text = asString(row.text) || asString(row.instruction);
      const order =
        typeof row.stepNumber === 'number'
          ? row.stepNumber
          : typeof row.step_number === 'number'
            ? row.step_number
            : typeof row.step === 'number'
              ? row.step
              : index + 1;
      return { order, text };
    })
    .map((step) => ({ ...step, text: step.text.trim() }))
    .filter((step) => step.text.length > 0)
    .sort((a, b) => a.order - b.order)
    .slice(0, DETAILS_MAX_STEPS)
    .map((step) => step.text);
}

export function projectRecipeDetailsForModel(recipe: {
  id: string;
  title: string;
  mealType: string;
  servings: number | null;
  prepTimeMinutes: number | null;
  nutritionKcal: number | null;
  nutritionProtein: number | null;
  nutritionFat: number | null;
  nutritionCarbs: number | null;
  allergens: string[];
  dietTags: string[];
  isCatalog: boolean;
  sourceInstructions?: unknown;
  ingredients?: { name: string; amount: number; unit: string }[];
}): RecipeDetailsForModel {
  const servings = Math.max(1, recipe.servings ?? 1);
  const perServing = (value: number | null): number =>
    Math.round((value ?? 0) / servings);
  return {
    id: recipe.id,
    title: recipe.title,
    mealType: recipe.mealType,
    servings,
    prepTimeMinutes: recipe.prepTimeMinutes ?? 0,
    kcalPerServing: perServing(recipe.nutritionKcal),
    proteinPerServing: perServing(recipe.nutritionProtein),
    fatPerServing: perServing(recipe.nutritionFat),
    carbsPerServing: perServing(recipe.nutritionCarbs),
    allergens: recipe.allergens,
    dietTags: recipe.dietTags,
    ingredients: (recipe.ingredients ?? [])
      .slice(0, DETAILS_MAX_INGREDIENTS)
      .map((row) => ({
        name: row.name,
        amount: Math.round(row.amount * 100) / 100,
        unit: row.unit,
      })),
    steps: readRecipeSteps(recipe.sourceInstructions),
    isCatalog: recipe.isCatalog,
  };
}

/**
 * Dopasowanie nazwy produktu wypowiedzianej przez człowieka do pozycji listy.
 *
 * Model nie dostaje listy zakupów w wyniku `show_shopping_list` (dostałby
 * pokusę przepisania jej w odpowiedzi), więc nie ma skąd wziąć `productKey`.
 * Mówi więc nazwami — „kupiłem mleko i jajka" — a dopasowanie robi serwer.
 *
 * Trzy progi, w tej kolejności: dokładna nazwa, potem zawieranie w jedną albo
 * drugą stronę („jajka" w „jajka kurze", „mleko" w „mleko 2%"), a na końcu
 * wspólny rdzeń czterech znaków, bo polska odmiana zmienia końcówkę
 * („jajka"/„jajko"). Sortowanie po długości nazwy wybiera najkrótszą, czyli
 * najbardziej ogólną pozycję — „mleko" przed „mleko kokosowe".
 *
 * Wieloznaczność NIE jest odhaczana na chybił trafił: gdy próg trafia więcej
 * niż jedną pozycję, oddajemy je modelowi jako `ambiguous` i to użytkownik
 * rozstrzyga. Odhaczenie nie swojego produktu jest ciche — nikt tego nie
 * zauważy aż do sklepu.
 */
export function matchShoppingProduct(
  query: string,
  items: readonly { productKey: string; name: string }[],
): {
  matched: { productKey: string; name: string } | null;
  ambiguous: string[];
} {
  const needle = normalizeText(query);
  if (!needle) return { matched: null, ambiguous: [] };

  const rows = items.map((item) => ({ item, name: normalizeText(item.name) }));
  // Rdzeń liczymy tą samą funkcją, co wyszukiwarka składników: najdłuższe
  // słowo przycięte do czterech znaków. „mąki pszennej" ma rdzeń „psze",
  // więc trafia w „mąka pszenna" mimo dwóch różnych końcówek — reguła na
  // prefiksie pierwszego słowa gubiła to („maki" ≠ „maka").
  const stem = searchStem(query);

  const tiers = [
    rows.filter((row) => row.name === needle),
    rows.filter(
      (row) => row.name.includes(needle) || needle.includes(row.name),
    ),
    stem ? rows.filter((row) => row.name.includes(stem)) : [],
  ];

  for (const tier of tiers) {
    if (tier.length === 0) continue;
    // WIĘCEJ NIŻ JEDEN KANDYDAT = pytanie do użytkownika, nie zgadywanie.
    // „ser" pasuje do białego i żółtego równie dobrze; wybranie krótszej
    // nazwy byłoby rzutem monetą, którego nikt nie zauważy aż do sklepu.
    if (tier.length === 1) return { matched: tier[0].item, ambiguous: [] };
    return {
      matched: null,
      ambiguous: tier
        .map((row) => row.item.name)
        .sort((a, b) => a.localeCompare(b, 'pl')),
    };
  }

  return { matched: null, ambiguous: [] };
}

/**
 * Trafienie `find_recipes` w kształcie dla modelu.
 *
 * `recipe` jest GOTOWĄ REFERENCJĄ dla kolejnych narzędzi — indeksem katalogu
 * tej tury (`R007`) albo identyfikatorem przepisu domu. Bez tego model
 * dostawałby UUID i wpisywał go tam, gdzie kod spodziewa się indeksu — albo,
 * co gorsza, przepisywał go z pamięci z błędem.
 */
export type RecipeHitForModel = {
  recipe: string;
  title: string;
  slots: MealType[];
  tags: string[];
  /** Kcal i białko NA PORCJĘ — do „lekkie"/„dużo białka", nie do bilansu. */
  kcal: number | null;
  protein: number | null;
  prepMinutes: number;
  why: string[];
  household?: true;
};

/**
 * Wynik `find_recipes` dla modelu — tylko to, po czym model WYBIERA (Etap 3.6).
 * Bez tłuszczu, węgli, porcji przepisu, alergenów, tagów diety i składników:
 * alergeny i diety nakłada serwer (te same reguły, co walidator), a skład
 * i pełne makro daje `get_recipe_details`. Serwer dalej liczy na pełnym
 * rekordzie — chudnie wyłącznie to, co idzie do modelu.
 */
export type FindRecipesForModel = Omit<AgentSearchResult, 'hits'> & {
  hits: RecipeHitForModel[];
};

const MEAL_TYPES: readonly MealType[] = [
  'BREAKFAST',
  'SECOND_BREAKFAST',
  'LUNCH',
  'AFTERNOON_SNACK',
  'DINNER',
  'SNACK',
];

/**
 * Narzędzia, po których udanym wywołaniu tura jest SKOŃCZONA: karta stoi,
 * a model i tak kończy turę (instrukcje: „po tym narzędziu kończysz turę",
 * „najwyżej dwa zdania"). Dostawca nie woła wtedy modelu jeszcze raz tylko
 * po to, żeby dopisał zdanie — napisał je w tej samej wiadomości, co
 * wywołanie (pomiar 24.09.2026: ta ostatnia runda to 18 % czasu tury).
 */
export const TURN_ENDING_TOOLS: ReadonlySet<string> = new Set([
  'ask_clarifying_question',
  'offer_options',
  'suggest_meals',
  'propose_week_plan',
  'propose_day_plan',
  'propose_swap',
  'propose_remove_meal',
  'propose_household_split',
  'revise_proposal',
  'build_meal_plan',
  'replace_plan_item',
]);

/**
 * Składnik z wyszukiwarki — tyle, ile trzeba do zbudowania przepisu.
 *
 * Wypadają `category`, `dietTags` i `gramsPerPiece`: model wybiera składnik
 * po nazwie, a alergeny i tagi diety przepisu liczy serwer ze składu, więc
 * nie ma ich po co czytać przy wyborze. `allergens` zostają, bo po nich
 * model widzi, że dokłada do przepisu coś, czego domownik nie zje.
 */
export type IngredientForModel = {
  id: string;
  name: string;
  allowedUnits: string[];
  hasNutrition: boolean;
  allergens: string[];
};

export function projectIngredientsForModel(
  rows: readonly {
    id: string;
    name: string;
    allowedUnits: string[];
    hasNutrition: boolean;
    allergens: string[];
  }[],
): IngredientForModel[] {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    allowedUnits: row.allowedUnits,
    hasNutrition: row.hasNutrition,
    allergens: row.allergens,
  }));
}

export type AgentToolContext = {
  userId: string;
  householdId: string;
  /** `R07` → `recipeId`; z digestu katalogu tej tury. */
  catalogIndex: Record<string, string>;
  /**
   * Rozmowa i tura, w których to się dzieje.
   *
   * Propozycja musi wiedzieć, do której wiadomości się przypnie — a że model
   * nie ma jak tego podać (i nie powinien), idzie to tą samą drogą co
   * tożsamość: z tury, nie z wejścia narzędzia.
   */
  conversationId: string;
  turnId: string;
  /**
   * Tryb tury. Bramka na narzędzia jest tu, a nie na liście narzędzi, bo
   * lista liczy się do prefiksu cache i musi być identyczna w obu trybach
   * (patrz `modeBlock` w `agent-system-prompt.ts`).
   */
  proposalMode: boolean;
  /**
   * Karta, która NIE zapisuje niczego (pytanie, zestawienie, wybór).
   *
   * Propozycje idą przez bazę, bo muszą przeżyć pad procesu i dać się
   * zatwierdzić kwadrans później. Karta bez skutków ubocznych nie ma czego
   * przeżywać: gdy tura padnie, nie powstaje żadna wiadomość, więc nie ma
   * jej gdzie pokazać. Wiersz w bazie byłby tu wyłącznie kosztem.
   */
  collectCard: (card: AgentCard) => void;
  /**
   * Zakres planowania tury (`plan-scope.ts`): najwyżej tydzień na prośbę
   * i tylko bliskie tygodnie. Runner podaje oba pola zawsze; opcjonalne,
   * bo narzędzia wołane poza turą (testy) nie mają tury, której by pilnowały.
   */
  planScope?: PlanScope;
  dates?: PlanScopeDates;
  /**
   * Pamięć tury (`turn-memo.ts`): domownicy, zgody i pory czytane raz na
   * turę oraz rezerwacja JEDNEJ karty. Runner podaje ją zawsze; opcjonalna
   * dla wywołań spoza tury (testy, skrypty).
   */
  memo?: TurnMemo;
};

/**
 * Wynik narzędzia w formie, którą model potrafi przetworzyć.
 *
 * Błąd wraca jako DANE, nie jako wyjątek. To jest sedno: wyjątek zabiłby całą
 * turę i użytkownik zobaczyłby „coś poszło nie tak", podczas gdy model umie
 * poprawić większość z tych sytuacji sam — dopisać brakujący składnik, wybrać
 * inne danie do slotu, sięgnąć po wyszukiwarkę zamiast zgadywać identyfikator.
 * Kod błędu jest tym, po czym model rozpoznaje, co zrobić.
 */
/**
 * Wartość z narzędzia jako tekst — obiekt daje pusty string, nie
 * „[object Object]". Wejście modelu bywa dowolnego kształtu, a pusty string
 * zatrzyma się na walidacji DTO z czytelnym komunikatem; „[object Object]"
 * przeszedłby dalej jako tytuł przepisu.
 */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export type AgentToolResult =
  | {
      ok: true;
      data: unknown;
      /**
       * Udane narzędzie z `TURN_ENDING_TOOLS`: karta powstała i tura może się
       * skończyć bez kolejnego wywołania modelu (patrz dostawca).
       */
      endsTurn?: true;
      /**
       * Zdanie serwera na koniec tury, gdy model nie napisał nic przed
       * wywołaniem (karta mówi resztę). Bez niego dostawca wołałby model
       * jeszcze raz tylko po jedno zdanie. Brak = model ma coś do
       * wyjaśnienia (np. plan PARTIAL) i dostaje głos.
       */
      turnText?: string;
    }
  | { ok: false; error: { code: string; message: string; details?: string[] } };

/**
 * Ile pozycji planu wolno USUNĄĆ zapisem, którego nie zatwierdził człowiek.
 *
 * Dwie, czyli tyle, ile znaczy „popraw wtorek i czwartek". Trzecia i dalsze
 * to już przemeblowanie tygodnia i wymagają kliknięcia w kartę propozycji.
 */
const MAX_DIRECT_PLAN_REMOVALS = 2;

@Injectable()
export class AgentToolExecutor {
  private readonly logger = new Logger(AgentToolExecutor.name);

  constructor(
    private readonly households: HouseholdsService,
    private readonly weeklyPlans: WeeklyPlansService,
    private readonly recipes: RecipesService,
    private readonly ingredients: IngredientsService,
    private readonly prisma: PrismaService,
    private readonly counters: AiUsageCountersService,
    private readonly metrics: AgentMetricsService,
    private readonly memory: AgentMemoryService,
    private readonly proposals: AgentProposalsService,
    private readonly shoppingList: ShoppingListService,
    // Rozgłoszenia tą samą drogą, co zmiany zrobione palcem w aplikacji —
    // patrz `broadcastMealEaten` / `broadcastShoppingItemChecked`.
    private readonly plansGateway: WeeklyPlansGateway,
    // Filtr zgód domowników — ta sama reguła, co przy budowie promptu.
    private readonly prompts: AgentPromptService,
    // Indeks katalogu w pamięci i wyszukiwarka dań (`find_recipes`).
    private readonly catalog: AgentCatalogService,
    // Serwerowy planer (Etap 2): `build_meal_plan`, `replace_plan_item`.
    private readonly planner: AgentMealPlannerService,
  ) {}

  async execute(
    name: string,
    input: Record<string, unknown>,
    context: AgentToolContext,
  ): Promise<AgentToolResult> {
    if (!EXECUTABLE_TOOL_NAMES.includes(name)) {
      // Model wywołał narzędzie, którego nie ma na liście. Zdarza się rzadko,
      // ale odpowiedź musi być danymi — inaczej tura pada przez literówkę.
      return this.failure('BAD_REQUEST', `Nie ma narzędzia o nazwie ${name}.`);
    }

    // Jedna karta na turę — rezerwacja SYNCHRONICZNIE, przed pierwszym
    // `await`, więc z dwóch kart w jednej rundzie wygrywa dokładnie jedna
    // (patrz `TurnMemo.claimCard`). Odmowa narzędzia zwalnia rezerwację.
    const cardTool = TURN_ENDING_TOOLS.has(name);
    if (cardTool && context.memo) {
      const holder = context.memo.claimCard(name);
      if (holder !== null) {
        return this.failure(
          'AI_ONE_CARD_PER_TURN',
          `W tej odpowiedzi stoi już karta (${holder}) — wiadomość niesie jedną kartę. ` +
            'Resztę powiedz słowami albo zaproponuj w następnej wiadomości.',
        );
      }
    }
    const result = await this.executeClaimed(name, input, context);
    if (cardTool && !(result.ok && result.endsTurn)) {
      context.memo?.releaseCard(name);
    }
    return result;
  }

  private async executeClaimed(
    name: string,
    input: Record<string, unknown>,
    context: AgentToolContext,
  ): Promise<AgentToolResult> {
    const refusal = this.refuseOutOfMode(name, context);
    if (refusal) return refusal;

    const outOfScope = this.refuseOutOfPlanScope(name, input, context);
    if (outOfScope) return outOfScope;

    const destructive = await this.refuseDestructiveWrite(name, input, context);
    if (destructive) return destructive;

    try {
      const data = redactViolationsForModel(
        await this.dispatch(name, input, context),
      );
      if (context.planScope) {
        recordPlannedDays(name, input, context.planScope);
      }
      // Propozycja z naruszeniami (`proposed: false`) NIE kończy tury:
      // model musi poprawić dania i zawołać jeszcze raz.
      const endsTurn =
        TURN_ENDING_TOOLS.has(name) &&
        (data as { proposed?: unknown } | null)?.proposed !== false;
      const turnText = endsTurn ? turnTextFor(name, input, data) : null;
      return {
        ok: true,
        data,
        ...(endsTurn ? { endsTurn: true as const } : {}),
        ...(turnText ? { turnText } : {}),
      };
    } catch (error) {
      const { contract } = mapError(error);
      if (!(error instanceof AppException)) {
        // Nieznany błąd to nasza awaria, nie pomyłka modelu — w logu zostaje
        // ślad, do modelu idzie tylko tyle, żeby wiedział, że ma odpuścić.
        this.logger.error(
          `narzędzie ${name} rzuciło nieoczekiwany błąd`,
          error instanceof Error ? error.stack : undefined,
        );
      }
      return {
        ok: false,
        error: {
          code: contract.code,
          message: contract.message,
          ...(contract.details ? { details: contract.details } : {}),
        },
      };
    }
  }

  private failure(code: string, message: string): AgentToolResult {
    return { ok: false, error: { code, message } };
  }

  /** Domownicy z celami — raz na turę (`TurnMemo`), jak w prompcie. */
  private members(context: AgentToolContext) {
    return memoized(
      context.memo,
      TURN_KEYS.members(context.userId, context.householdId),
      () =>
        this.households.memberPreferences(context.userId, context.householdId),
    );
  }

  /**
   * Domownicy, których model może zobaczyć (zgoda) — ten sam filtr i ten
   * sam wpis pamięci tury, co blok gospodarstwa w prompcie.
   */
  private visibleMembers(context: AgentToolContext) {
    return memoized(
      context.memo,
      TURN_KEYS.visible(context.userId, context.householdId),
      async () => this.prompts.membersForModel(await this.members(context)),
    );
  }

  /**
   * Druga bramka trybu — po prompcie, przed domeną.
   *
   * Prompt mówi modelowi, co ma robić; ta bramka pilnuje, żeby pomyłka nie
   * kosztowała użytkownika tygodnia. Bez niej model w trybie propozycji mógłby
   * po prostu zapisać plan (narzędzie jest na liście, bo lista musi być
   * identyczna w obu trybach ze względu na cache) i cały model „proponuję,
   * ty zatwierdzasz” byłby wyłącznie sugestią.
   *
   * Odmowa wraca jako DANE, nie wyjątek: model czyta ją, sięga po właściwe
   * narzędzie i kończy turę normalnie. Wyjątek zabiłby całą turę za coś,
   * z czego model potrafi się poprawić w jednej rundzie.
   */
  /**
   * Trzecia bramka: ile wolno USUNĄĆ bez kliknięcia człowieka.
   *
   * `refuseOutOfMode` pilnuje TRYBU, ta pilnuje SKUTKU — i działa nawet
   * wtedy, gdy ktoś świadomie zszedł na `off`. Powód: `apply_week_plan`
   * przyjmuje STAN DOCELOWY, więc czego nie ma na liście, tego nie ma
   * w planie. `slots: []` przechodzi walidację i kasuje cały tydzień jednym
   * wywołaniem, a „Cofnij" istnieje wyłącznie dla propozycji, więc tej drogi
   * nie da się odwrócić. Nie trzeba do tego napastnika — wystarczy, że model
   * źle zrozumie „ułóż mi tydzień od nowa".
   *
   * Liczbę usunięć bierzemy z SUCHEGO PRZEBIEGU tego samego zapisu, więc
   * reguła klucza jest dokładnie ta sama, co przy prawdziwym zapisie
   * (`planSlotKey`) — nie ma tu drugiej implementacji, która mogłaby się
   * rozjechać. Poniżej progu model dalej pracuje sam; powyżej musi przejść
   * przez `propose_week_plan`, czyli przez kliknięcie użytkownika.
   */
  private async refuseDestructiveWrite(
    name: string,
    input: Record<string, unknown>,
    context: AgentToolContext,
  ): Promise<AgentToolResult | null> {
    if (name !== 'apply_week_plan' || input.dry_run === true) return null;
    const weekStart = asString(input.week_start);
    if (!weekStart) return null;

    let deleted: number;
    try {
      const dry = await this.weeklyPlans.applyWeekPlan(
        context.userId,
        context.householdId,
        weekStart,
        {
          dryRun: true,
          slots: this.toSlots(input.slots, context),
        } as unknown as ApplyWeekPlanDto,
      );
      deleted = dry.changes.deleted;
    } catch {
      // Suchy przebieg padł (zmyślony przepis, zła data, brak członkostwa) —
      // nie zgadujemy. Prawdziwy zapis zgłosi ten sam błąd normalną drogą,
      // z pełnym komunikatem dla modelu.
      return null;
    }

    if (deleted <= MAX_DIRECT_PLAN_REMOVALS) return null;
    this.metrics.recordRejected('destructive');
    return this.failure(
      'AI_TOOL_NOT_IN_MODE',
      `Ten zapis usunąłby ${deleted} pozycji z planu, a bez potwierdzenia ` +
        `użytkownika wolno usunąć najwyżej ${MAX_DIRECT_PLAN_REMOVALS}. ` +
        'Podaj ten sam stan docelowy przez propose_week_plan — użytkownik ' +
        'zatwierdzi go jednym kliknięciem w aplikacji.',
    );
  }

  /**
   * Zapis notatki do pamięci domu — z jawnym adresatem, jeśli notatka jest
   * o konkretnej osobie.
   *
   * Adresat jest sprawdzany PRZED zapisem wobec listy domowników ZE ZGODĄ
   * (tej samej, którą dostaje prompt). Notatka o osobie bez zgody nie
   * powstaje w ogóle — to jest tańsze i pewniejsze niż odsiewanie jej potem
   * przy każdym budowaniu promptu, a przy okazji zamyka drogę, którą dane
   * o zdrowiu jednej osoby lądowały w bazie z winy drugiej.
   *
   * Model podaje `about_user_id` z `get_household_context`, więc identyfikator
   * pochodzi z listy, którą sam dostał, a nie z jego wyobraźni. Zmyślony
   * i tak nie przejdzie: nie ma go wśród domowników ze zgodą.
   */
  private async rememberNote(
    input: Record<string, unknown>,
    context: AgentToolContext,
  ): Promise<unknown> {
    const { userId, householdId } = context;
    const about = asString(input.about_user_id).trim();
    if (!about) {
      return this.memory.remember(
        householdId,
        userId,
        asString(input.text),
        asString(input.kind) || undefined,
      );
    }

    const { members } = await this.visibleMembers(context);
    if (!members.some((member) => member.userId === about)) {
      throw new AppException(
        'VALIDATION_ERROR',
        'Ta osoba nie zgodziła się na asystenta albo nie ma jej w tym domu — ' +
          'nie zapisuję o niej notatki. Zapisz zdanie bez wskazywania osoby ' +
          'albo pomiń je zupełnie.',
        HttpStatus.BAD_REQUEST,
        ['about_user_id'],
      );
    }

    return this.memory.remember(
      householdId,
      userId,
      asString(input.text),
      asString(input.kind) || undefined,
      about,
    );
  }

  /**
   * Czwarta bramka: ILE planu naraz — najwyżej tydzień na prośbę i tylko
   * bliskie tygodnie (`plan-scope.ts`). Odmowa jako dane, jak przy trybie:
   * model kończy turę tym, co już ułożył, zamiast padać całą turą.
   */
  private refuseOutOfPlanScope(
    name: string,
    input: Record<string, unknown>,
    context: AgentToolContext,
  ): AgentToolResult | null {
    if (!context.planScope || !context.dates) return null;
    const refusal = checkPlanScope(
      name,
      input,
      context.planScope,
      context.dates,
    );
    if (!refusal) return null;
    this.metrics.recordRejected('planRange');
    return this.failure('AI_PLAN_RANGE_EXCEEDED', refusal.message);
  }

  private refuseOutOfMode(
    name: string,
    context: AgentToolContext,
  ): AgentToolResult | null {
    if (name === 'apply_week_plan' && context.proposalMode) {
      return this.failure(
        'AI_TOOL_NOT_IN_MODE',
        'W tym trybie nie zapisujesz planu sam. Plan dnia albo tygodnia ułóż przez ' +
          'build_meal_plan — użytkownik zatwierdzi go jednym kliknięciem w aplikacji.',
      );
    }
    if (
      (name === 'propose_week_plan' ||
        name === 'propose_day_plan' ||
        name === 'propose_swap' ||
        name === 'propose_remove_meal' ||
        name === 'propose_household_split' ||
        name === 'revise_proposal' ||
        name === 'build_meal_plan' ||
        name === 'replace_plan_item') &&
      !context.proposalMode
    ) {
      return this.failure(
        'AI_TOOL_NOT_IN_MODE',
        'W tym trybie propozycje są wyłączone. Zapisz plan sam przez apply_week_plan — ' +
          'najpierw z dry_run=true, żeby sprawdzić naruszenia.',
      );
    }
    return null;
  }

  private dispatch(
    name: string,
    input: Record<string, unknown>,
    context: AgentToolContext,
  ): Promise<unknown> {
    const { userId, householdId } = context;
    const str = (key: string): string => asString(input[key]);

    switch (name) {
      case 'get_week_plan':
        return this.weekPlanForModel(context, str('week_start'));

      case 'get_week_balance':
        return this.weekBalanceForModel(input, context, str('week_start'));

      case 'get_recipe_details':
        return this.recipeDetails(input, context);

      case 'find_recipes':
        return this.findRecipes(input, context);

      case 'suggest_meals':
        return this.suggestMeals(input, context, str('week_start'));

      case 'search_ingredients':
        return this.ingredients
          .search({
            query: str('query'),
            onlyWithNutrition: input.only_with_nutrition === true,
            ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
          })
          .then(projectIngredientsForModel);

      case 'ask_clarifying_question':
        return Promise.resolve(this.askClarifyingQuestion(input, context));

      case 'offer_options':
        return this.offerOptions(input, context);

      case 'propose_swap':
        return this.proposeSwap(input, context, str('week_start'));

      case 'propose_remove_meal':
        return this.proposeRemoveMeal(input, context, str('week_start'));

      case 'propose_household_split':
        return this.proposeHouseholdSplit(input, context, str('week_start'));

      case 'show_macro_gap':
        return this.showMacroGap(input, context, str('week_start'));

      case 'mark_meal_eaten':
        return this.markMealEaten(input, context, str('week_start'));

      case 'check_shopping_items':
        return this.checkShoppingItems(input, context, str('week_start'));

      case 'check_plan_conflicts':
        return this.checkPlanConflicts(context, str('week_start'));

      case 'show_shopping_list':
        return this.showShoppingList(context, str('week_start'));

      case 'propose_day_plan':
        return this.proposeDayPlan(input, context, str('week_start'));

      case 'propose_week_plan':
        return this.proposeWeekPlan(input, context, str('week_start'));

      case 'revise_proposal':
        return this.reviseProposal(input, context);

      case 'build_meal_plan':
        return this.buildMealPlan(input, context, str('week_start'));

      case 'replace_plan_item':
        return this.replacePlanItem(input, context, str('week_start'));

      case 'apply_week_plan':
        return this.applyWeekPlan(input, context, str('week_start'));

      case 'create_recipe': {
        const payload: unknown = {
          householdId,
          title: str('title'),
          ...(input.description ? { description: str('description') } : {}),
          mealType: str('meal_type'),
          difficulty: 'EASY',
          // NIE zero: `CreateRecipeDto` wymaga >= 1, więc brak wartości
          // kończył się „prepTimeMinutes must not be less than 1" — komunikatem
          // o polu, które w schemacie narzędzia było opcjonalne, więc model
          // nie miał jak się poprawić. Teraz pole jest wymagane w schemacie,
          // a to jest ostatnia siatka.
          prepTimeMinutes:
            typeof input.prep_time_minutes === 'number' &&
            input.prep_time_minutes >= 1
              ? input.prep_time_minutes
              : 30,
          servings: Number(input.servings ?? 1),
          ingredients: this.toIngredients(input.ingredients),
          ...(input.steps ? { steps: this.toSteps(input.steps) } : {}),
        };
        return this.recipes
          .create(userId, payload as CreateRecipeDto)
          .then(projectRecipeForModel);
      }

      case 'update_recipe': {
        const payload: unknown = {
          householdId,
          ...(input.title ? { title: str('title') } : {}),
          ...(input.description ? { description: str('description') } : {}),
          ...(input.prep_time_minutes !== undefined
            ? { prepTimeMinutes: Number(input.prep_time_minutes) }
            : {}),
          ...(input.servings !== undefined
            ? { servings: Number(input.servings) }
            : {}),
          ...(input.ingredients
            ? { ingredients: this.toIngredients(input.ingredients) }
            : {}),
          ...(input.steps ? { steps: this.toSteps(input.steps) } : {}),
        };
        return this.recipes
          .update(userId, str('recipe_id'), payload as UpdateRecipeDto)
          .then(projectRecipeForModel);
      }

      case 'remember_note':
        return this.rememberNote(input, context);

      case 'start_planning':
        // Sama zmiana modelu dzieje się w dostawcy (patrz AgentProviderHandoff);
        // tu potwierdzenie, które planista przeczyta jako pierwsze, i od razu
        // kandydaci na pory domu — bez tego pierwszą rundą planisty byłoby
        // i tak szukanie dań.
        return Promise.resolve(this.startPlanning());

      default:
        return Promise.resolve(null);
    }
  }

  /**
   * Zapis tygodnia z miesięczną kwotą planów (`AI_LIMIT_PLANS_PER_MONTH`).
   *
   * Kwota schodzi PRZED zapisem i wraca, gdy zapisu nie było — tak samo jak
   * kwota wiadomości w `AgentTurnRunner`. Kolejność ma znaczenie: policzenie
   * po zapisie znaczyłoby, że przy wyczerpanym limicie plan i tak wylądował
   * w bazie, a odmowa byłaby kłamstwem.
   *
   * Co NIE liczy się do kwoty: `dry_run` (nic nie pisze), zapis odrzucony
   * przez naruszenia (`applied: false` — serwis nie zapisuje nic przy
   * jakimkolwiek naruszeniu) i zapis, który nie zmienił ani jednej pozycji.
   * Ten ostatni przypadek jest ważny: model, który powtarza ten sam stan
   * docelowy, nie ma prawa spalić komuś limitu na tydzień.
   */
  /**
   * Propozycja tygodnia — policz i pokaż, nie zapisuj.
   *
   * Nie schodzi tu kwota planów: propozycja nic nie zmienia w bazie
   * gospodarstwa, więc nie ma za co jej liczyć. Limit obciąża dopiero
   * zatwierdzenie, czyli moment, w którym tydzień naprawdę się zmienia.
   */
  /**
   * Pytanie z gotowymi odpowiedziami — jedyne narzędzie, które nic nie liczy.
   *
   * Modelowi oddajemy potwierdzenie, a nie kartę: gdyby dostał kartę, dopisałby
   * jeszcze pytanie w tekście i użytkownik przeczytałby to samo dwa razy.
   */
  private askClarifyingQuestion(
    input: Record<string, unknown>,
    context: AgentToolContext,
  ): { asked: true; options: number } {
    const question = asString(input.question).trim();
    if (question.length === 0) {
      throw new AppException(
        'VALIDATION_ERROR',
        'Pytanie nie może być puste.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const options = (Array.isArray(input.options) ? input.options : [])
      .map((option) => asString(option).trim())
      .filter((option) => option.length > 0);
    if (options.length < 2) {
      throw new AppException(
        'VALIDATION_ERROR',
        'Podaj co najmniej dwie gotowe odpowiedzi — pytanie bez nich wymaga pisania na klawiaturze.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const hint = asString(input.hint).trim();
    context.collectCard(
      buildClarifyCard({ question, options, ...(hint ? { hint } : {}) }),
    );
    return {
      asked: true,
      options: Math.min(options.length, MAX_CLARIFY_OPTIONS),
    };
  }

  /**
   * Dania do wyboru — karta bez propozycji.
   *
   * Nazwy, kalorie, czas i zdjęcie bierzemy Z BAZY, po identyfikatorach
   * podanych przez model. Gdyby wypisywał je sam, kafelek pokazywałby liczby
   * z jego pamięci — wyglądające dokładnie tak samo jak prawdziwe.
   */
  private async offerOptions(
    input: Record<string, unknown>,
    context: AgentToolContext,
  ): Promise<{ offered: number }> {
    const raw = Array.isArray(input.options) ? input.options : [];
    if (raw.length < 2) {
      throw new AppException(
        'VALIDATION_ERROR',
        'Podaj co najmniej dwa dania do wyboru — jedno to nie wybór.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const unknownRefs = raw
      .map((option) => asString((option as Record<string, unknown>)?.recipe))
      .filter(
        (ref) => /^R\d+$/.test(ref) && context.catalogIndex[ref] === undefined,
      );
    if (unknownRefs.length > 0) {
      throw new AppException(
        'RECIPE_NOT_FOUND',
        `Nie ma takich przepisów w katalogu: ${unknownRefs.join(', ')}.`,
        HttpStatus.NOT_FOUND,
        unknownRefs,
      );
    }

    const options: OptionsCardItem[] = [];
    for (const option of raw.slice(0, MAX_OPTIONS)) {
      const entry = (option ?? {}) as Record<string, unknown>;
      const recipeId = this.resolveRecipeRef(asString(entry.recipe), context);
      const detail = await this.recipeSide(recipeId, context);
      const tag = asString(entry.tag).trim();
      options.push({
        recipeId,
        title: detail.title,
        kcalPerServing: detail.kcalPerServing,
        prepTimeMinutes: detail.prepTimeMinutes,
        imageUrl: detail.imageUrl,
        description: detail.description,
        proteinGrams: detail.proteinGrams,
        carbsGrams: detail.carbsGrams,
        fatGrams: detail.fatGrams,
        ingredientCount: detail.ingredientCount,
        tag: tag ? tag : null,
        prompt: optionPrompt(detail.title),
      });
    }

    const slotLabel = asString(input.slot_label).trim();
    context.collectCard(
      buildOptionsCard({
        title: asString(input.title),
        options,
        ...(slotLabel ? { slotLabel } : {}),
      }),
    );
    return { offered: options.length };
  }

  /**
   * Podmiana jednego dania.
   *
   * „Przed” czytamy z planu, a nie od modelu: to jedyna strona tej karty,
   * której model nie ma prawa znać z pamięci — a zarazem ta, po której
   * użytkownik ocenia, czy podmiana ma sens.
   */
  private async proposeSwap(
    input: Record<string, unknown>,
    context: AgentToolContext,
    weekStart: string,
    /** Porcje per osoba z planera (Etap 2.2) — tylko podmiana całego slotu. */
    portions?: { userId: string; servings: number }[],
  ): Promise<CreateWeekProposalResult> {
    const dayOfWeek = asString(input.day_of_week) as DayOfWeek;
    const mealType = asString(input.meal_type) as MealType;
    const ref = asString(input.recipe);
    if (/^R\d+$/.test(ref) && context.catalogIndex[ref] === undefined) {
      throw new AppException(
        'RECIPE_NOT_FOUND',
        `Nie ma takiego przepisu w katalogu: ${ref}.`,
        HttpStatus.NOT_FOUND,
        [ref],
      );
    }
    const recipeId = this.resolveRecipeRef(ref, context);

    const current = await this.weeklyPlans.snapshotWeekAsSlots(
      context.userId,
      context.householdId,
      weekStart,
    );
    const standing = current.find(
      (slot) => slot.dayOfWeek === dayOfWeek && slot.mealType === mealType,
    );

    const reason = asString(input.reason).trim();
    // Brak uczestników od modelu = całe gospodarstwo. Kogo dotyczy pytanie,
    // model czyta z samego zdania — nie ma już osobnego wyboru w aplikacji.
    const participantIds = Array.isArray(input.participant_user_ids)
      ? (input.participant_user_ids as string[])
      : [];

    return this.proposals.createSwapProposal({
      memo: context.memo,
      userId: context.userId,
      householdId: context.householdId,
      conversationId: context.conversationId,
      turnId: context.turnId,
      weekStart,
      dayOfWeek,
      mealType,
      recipeId,
      to: await this.recipeSide(recipeId, context),
      from: standing ? await this.recipeSide(standing.recipeId, context) : null,
      participantIds,
      ...(reason ? { reason } : {}),
      ...(portions?.length && participantIds.length === 0 ? { portions } : {}),
    });
  }

  /**
   * Usunięcie jednego dania.
   *
   * Co znika, czytamy z PLANU, a nie od modelu — dokładnie z tego samego
   * powodu, co „przed" przy podmianie: to jest jedyna strona tej karty,
   * której model nie ma prawa znać z pamięci, a zarazem ta, po której
   * użytkownik poznaje, czy klika w to, co myśli.
   *
   * Pusty slot kończy się błędem dla modelu, nie propozycją „usuń nic":
   * karta bez dania nie ma o czym mówić, a model po takim komunikacie
   * poprawia się sam w jednej rundzie.
   */
  private async proposeRemoveMeal(
    input: Record<string, unknown>,
    context: AgentToolContext,
    weekStart: string,
  ): Promise<CreateWeekProposalResult> {
    const dayOfWeek = asString(input.day_of_week) as DayOfWeek;
    const mealType = asString(input.meal_type) as MealType;

    const current = await this.weeklyPlans.snapshotWeekAsSlots(
      context.userId,
      context.householdId,
      weekStart,
    );
    const standing = current.find(
      (slot) => slot.dayOfWeek === dayOfWeek && slot.mealType === mealType,
    );
    if (!standing) {
      throw new AppException(
        'VALIDATION_ERROR',
        'W tym slocie nic nie stoi — nie ma czego usuwać. Sprawdź plan przez ' +
          'get_week_plan i powiedz użytkownikowi, że to miejsce jest już puste.',
        HttpStatus.BAD_REQUEST,
        ['day_of_week', 'meal_type'],
      );
    }

    const reason = asString(input.reason).trim();
    const participantIds = Array.isArray(input.participant_user_ids)
      ? (input.participant_user_ids as string[])
      : [];

    return this.proposals.createRemoveMealProposal({
      memo: context.memo,
      userId: context.userId,
      householdId: context.householdId,
      conversationId: context.conversationId,
      turnId: context.turnId,
      weekStart,
      dayOfWeek,
      mealType,
      removed: await this.recipeSide(standing.recipeId, context),
      participantIds,
      ...(reason ? { reason } : {}),
    });
  }

  /**
   * Jedno danie, kilka talerzy.
   */
  private async proposeHouseholdSplit(
    input: Record<string, unknown>,
    context: AgentToolContext,
    weekStart: string,
  ): Promise<CreateWeekProposalResult> {
    const ref = asString(input.recipe);
    if (/^R\d+$/.test(ref) && context.catalogIndex[ref] === undefined) {
      throw new AppException(
        'RECIPE_NOT_FOUND',
        `Nie ma takiego przepisu w katalogu: ${ref}.`,
        HttpStatus.NOT_FOUND,
        [ref],
      );
    }

    const raw = Array.isArray(input.portions) ? input.portions : [];
    const portions = raw
      .map((entry) => (entry ?? {}) as Record<string, unknown>)
      .map((entry) => ({
        userId: asString(entry.user_id),
        note: asString(entry.note).trim() || null,
      }))
      .filter((portion) => portion.userId.length > 0);
    if (portions.length === 0) {
      throw new AppException(
        'VALIDATION_ERROR',
        'Podaj, kto je to danie — bez tego karta nie ma o czym mówić.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const recipeId = this.resolveRecipeRef(ref, context);
    return this.proposals.createHouseholdSplitProposal({
      memo: context.memo,
      userId: context.userId,
      householdId: context.householdId,
      conversationId: context.conversationId,
      turnId: context.turnId,
      weekStart,
      dayOfWeek: asString(input.day_of_week) as DayOfWeek,
      mealType: asString(input.meal_type) as MealType,
      recipeId,
      dish: await this.recipeSide(recipeId, context),
      portions,
    });
  }

  /**
   * Lista zakupów tygodnia — policzona, nie przepisana.
   *
   * Modelowi oddajemy same liczniki. Gdyby dostał pozycje, wypisałby je
   * w odpowiedzi obok karty — i użytkownik przeczytałby tę samą listę dwa
   * razy, drugi raz gorzej sformatowaną.
   */
  /**
   * Konflikty alergenowe i wykluczenia w ZAPISANYM planie tygodnia.
   *
   * Bierze bieżący tydzień jako listę slotów i przepuszcza go przez tę samą
   * bramkę, co zapis (`previewWeekPlan` → `collectPlanViolations`), więc
   * odpowiedź asystenta i zachowanie przycisku „Dodaj do planu" nie mogą się
   * rozjechać. Do modelu wraca sam werdykt (~50 tokenów), bez składów i bez
   * imion osób, które nie wyraziły zgody na asystenta.
   *
   * POLE NAZYWA SIĘ `violations`, NIE `conflicts` — dla spójności z
   * `apply_week_plan` i `propose_*`, bo to dokładnie ta sama bramka i te same
   * kody. Nazwa NIE JEST już jednak mechanizmem bezpieczeństwa: redakcja idzie
   * za kształtem obiektu (`code` + `message`), więc pomyłka w nazwie nie
   * otworzy wycieku po raz drugi. To pole nie jest częścią kontraktu
   * z telefonem — wynik narzędzia widzi wyłącznie model.
   */
  /**
   * Plan tygodnia dla modelu — pełny odczyt domenowy, zawężony na granicy.
   *
   * Ten sam serwis i ta sama bramka członkostwa co dla telefonu; różnicą jest
   * wyłącznie to, ILE z wyniku jedzie dalej (patrz
   * `projectWeekPlanForModel`). Filtr zgód jest TEN SAM, co w
   * `get_household_context` i `show_macro_gap` — jedna reguła, jedno miejsce.
   */
  private async weekPlanForModel(
    context: AgentToolContext,
    weekStart: string,
  ): Promise<WeekPlanForModel> {
    const [plan, view] = await Promise.all([
      this.weeklyPlans.getByHouseholdAndWeek(
        context.userId,
        context.householdId,
        weekStart,
      ),
      this.planViewFor(context),
    ]);
    return projectWeekPlanForModel(plan, view.refByRecipeId, view.visible);
  }

  /**
   * Dwie rzeczy potrzebne, żeby przełożyć plan na kształt dla modelu:
   * odwrotny indeks katalogu i zbiór osób, które model może zobaczyć.
   *
   * Jedno miejsce, bo używają tego dwie drogi — odczyt (`get_week_plan`)
   * i potwierdzenie zapisu (`apply_week_plan`). Rozjazd między nimi znaczyłby,
   * że ten sam tydzień wygląda inaczej zależnie od tego, którędy się o niego
   * zapytało.
   */
  private async planViewFor(context: AgentToolContext): Promise<{
    refByRecipeId: Map<string, string>;
    visible: Set<string>;
  }> {
    const visible = await this.visibleMembers(context).then(
      (result) => new Set(result.members.map((m) => m.userId)),
    );
    return {
      refByRecipeId: new Map(
        Object.entries(context.catalogIndex).map(([ref, id]) => [id, ref]),
      ),
      visible,
    };
  }

  /**
   * Wynik zapisu przełożony dla modelu — patrz `ApplyWeekPlanForModel`.
   *
   * Przy `plan: null` (dry-run albo naruszenia) nie ma czego chudzić i nie
   * pytamy bazy o domowników.
   */
  private async applyResultForModel(
    result: ApplyWeekPlanResult,
    context: AgentToolContext,
  ): Promise<ApplyWeekPlanForModel> {
    const { plan, ...rest } = result;
    if (!plan) return { ...rest, plan: null };
    const view = await this.planViewFor(context);
    return {
      ...rest,
      plan: projectWeekPlanForModel(plan, view.refByRecipeId, view.visible),
    };
  }

  private async checkPlanConflicts(
    context: AgentToolContext,
    weekStart: string,
  ): Promise<{
    weekStart: string;
    checkedSlots: number;
    violations: {
      dayOfWeek: string;
      mealType: string;
      code: string;
      message: string;
    }[];
  }> {
    const slots = await this.weeklyPlans.snapshotWeekAsSlots(
      context.userId,
      context.householdId,
      weekStart,
    );
    if (slots.length === 0) {
      return { weekStart, checkedSlots: 0, violations: [] };
    }
    const preview = await this.weeklyPlans.previewWeekPlan(
      context.userId,
      context.householdId,
      weekStart,
      { slots },
    );
    return {
      weekStart,
      checkedSlots: slots.length,
      violations: preview.violations.map((violation) => ({
        dayOfWeek: violation.dayOfWeek,
        mealType: violation.mealType,
        code: violation.code,
        message: violation.message,
      })),
    };
  }

  /**
   * Odhaczenie „zjedzone" — z planu, nie od modelu.
   *
   * `SetMealEatenDto` adresuje posiłek trójką (dzień, posiłek, przepis), ale
   * przepisu NIE pytamy modelu: stoi w planie, a model, który podałby go
   * z pamięci, odhaczyłby nieistniejącą pozycję i dostał 404 zamiast zrobić
   * to, o co go poproszono. Przy okazji ubywa pole ze schematu, a limit pól
   * nieobowiązkowych jest wyczerpany co do jednego.
   *
   * Rozgłoszenie idzie tą samą drogą, co odhaczenie palcem w aplikacji —
   * inaczej drugi telefon w domu pokazywałby stary stan do przeładowania.
   */
  private async markMealEaten(
    input: Record<string, unknown>,
    context: AgentToolContext,
    weekStart: string,
  ): Promise<{
    eaten: boolean;
    dayOfWeek: string;
    mealType: string;
    title: string;
  }> {
    const dayOfWeek = asString(input.day_of_week) as DayOfWeek;
    const mealType = asString(input.meal_type) as MealType;
    const isEaten = input.eaten === true;

    const slots = await this.weeklyPlans.snapshotWeekAsSlots(
      context.userId,
      context.householdId,
      weekStart,
    );
    const standing = slots.find(
      (slot) => slot.dayOfWeek === dayOfWeek && slot.mealType === mealType,
    );
    if (!standing) {
      throw new AppException(
        'PLAN_ITEM_NOT_FOUND',
        'W tym slocie nic nie stoi — nie ma czego odhaczyć. Powiedz to wprost ' +
          'zamiast szukać dalej.',
        HttpStatus.NOT_FOUND,
        ['day_of_week', 'meal_type'],
      );
    }

    await this.weeklyPlans.setMealEaten(
      context.userId,
      context.householdId,
      weekStart,
      {
        dayOfWeek,
        mealType,
        recipeId: standing.recipeId,
        isEaten,
      } as unknown as SetMealEatenDto,
    );
    this.plansGateway.broadcastMealEaten({
      householdId: context.householdId,
      weekStart,
      changedByUserId: context.userId,
      dayOfWeek,
      mealType,
    });

    const side = await this.recipeSide(standing.recipeId, context);
    return { eaten: isEaten, dayOfWeek, mealType, title: side.title };
  }

  /**
   * Odhaczenie produktów z listy zakupów.
   *
   * Model podaje NAZWY, bo listy nie widzi (patrz `showShoppingList`) i nie ma
   * skąd wziąć `productKey`. Dopasowanie robi serwer i mówi wprost, czego nie
   * znalazł albo co było wieloznaczne — model powtarza to użytkownikowi
   * zamiast udawać, że odhaczył wszystko.
   *
   * Po odhaczeniu pokazujemy kartę listy z NOWYM stanem: użytkownik widzi
   * skutek od razu, bez pytania „to ile mi zostało".
   */
  private async checkShoppingItems(
    input: Record<string, unknown>,
    context: AgentToolContext,
    weekStart: string,
  ): Promise<{
    checked: string[];
    notFound: string[];
    ambiguous: string[];
    remaining: number;
  }> {
    const products = (Array.isArray(input.products) ? input.products : [])
      .map((entry) => asString(entry).trim())
      .filter((entry) => entry.length > 0);
    if (products.length === 0) {
      throw new AppException(
        'VALIDATION_ERROR',
        'Podaj, co użytkownik kupił — bez nazw nie ma czego odhaczyć.',
        HttpStatus.BAD_REQUEST,
        ['products'],
      );
    }

    const isChecked = input.checked === true;
    const items = await this.shoppingList.getShoppingList(
      context.userId,
      context.householdId,
      weekStart,
    );

    const checked: string[] = [];
    const notFound: string[] = [];
    const ambiguous: string[] = [];
    const done = new Set<string>();

    for (const product of products) {
      const { matched, ambiguous: rivals } = matchShoppingProduct(
        product,
        items,
      );
      if (!matched) {
        if (rivals.length > 0) ambiguous.push(...rivals);
        else notFound.push(product);
        continue;
      }
      // Ta sama pozycja w dwóch nazwach od modelu („jajka" i „jajko") to
      // jedno odhaczenie, nie dwa zapisy i dwa rozgłoszenia.
      if (done.has(matched.productKey)) continue;
      done.add(matched.productKey);

      await this.shoppingList.setShoppingItemChecked(
        context.userId,
        context.householdId,
        weekStart,
        {
          productKey: matched.productKey,
          isChecked,
        } as unknown as UpdateShoppingItemCheckDto,
      );
      this.plansGateway.broadcastShoppingItemChecked({
        householdId: context.householdId,
        weekStart,
        changedByUserId: context.userId,
        productKey: matched.productKey,
        isChecked,
      });
      checked.push(matched.name);
    }

    const card = buildShoppingListCard({
      weekStart,
      items: await this.shoppingList.getShoppingList(
        context.userId,
        context.householdId,
        weekStart,
      ),
      departmentOrder: Object.values(ShoppingDepartment),
      departmentKeys: Object.fromEntries(
        Object.entries(ShoppingDepartment).map(([key, label]) => [label, key]),
      ),
    });
    context.collectCard(card);

    return {
      checked,
      notFound,
      ambiguous: Array.from(new Set(ambiguous)),
      remaining: card.summary.remaining,
    };
  }

  private async showShoppingList(
    context: AgentToolContext,
    weekStart: string,
  ): Promise<{ remaining: number; checked: number; departments: number }> {
    const items = await this.shoppingList.getShoppingList(
      context.userId,
      context.householdId,
      weekStart,
    );

    const card = buildShoppingListCard({
      weekStart,
      items,
      departmentOrder: Object.values(ShoppingDepartment),
      departmentKeys: Object.fromEntries(
        Object.entries(ShoppingDepartment).map(([key, label]) => [label, key]),
      ),
    });
    context.collectCard(card);

    return {
      remaining: card.summary.remaining,
      checked: card.summary.checked,
      departments: card.groups.length,
    };
  }

  /**
   * Luka do celu — liczona TUTAJ, nie przepisana od modelu.
   *
   * Model dostaje z powrotem obie liczby, żeby mógł napisać zdanie zgodne
   * z kartą. Gdyby liczył je sam, karta i tekst pod nią mówiłyby dwie różne
   * rzeczy o tym samym tygodniu — i to tekst byłby tym błędnym.
   */
  private async showMacroGap(
    input: Record<string, unknown>,
    context: AgentToolContext,
    weekStart: string,
  ): Promise<{ macro: MacroKey; current: number; target: number }> {
    const macro = asString(input.macro).toUpperCase() as MacroKey;
    const boosters: MacroGapBooster[] = (
      Array.isArray(input.boosters) ? input.boosters : []
    )
      .map((entry) => (entry ?? {}) as Record<string, unknown>)
      .map((entry) => ({
        text: asString(entry.text).trim(),
        amount: typeof entry.amount === 'number' ? Math.round(entry.amount) : 0,
      }))
      .filter((booster) => booster.text.length > 0)
      .slice(0, MAX_BOOSTERS);

    const memberUserId = asString(input.member_user_id).trim();
    const targetUserId = memberUserId || context.userId;

    const [balance, members] = await Promise.all([
      this.weeklyPlans.weeklyBalance(
        context.userId,
        context.householdId,
        weekStart,
        memberUserId || undefined,
      ),
      this.visibleMembers(context).then((result) => result.members),
    ]);
    const member = members.find((entry) => entry.userId === targetUserId);
    if (!member) {
      // Także osoba bez zgody na asystenta: jej cele makro to dane o zdrowiu
      // i nie idą do modelu.
      throw new AppException(
        'PLAN_PARTICIPANT_NOT_IN_HOUSEHOLD',
        'Ta osoba nie należy do gospodarstwa albo nie wyraziła zgody na asystenta.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const target = this.macroTarget(macro, member);
    if (target === null) {
      throw new AppException(
        'VALIDATION_ERROR',
        'Ta osoba nie ma policzonego celu dla tego makro — nie ma czego z czym porównać. ' +
          'Powiedz to wprost zamiast pokazywać kartę.',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Średnia z DNI, w których cokolwiek zaplanowano: dzieląc przez siedem,
    // pusty piątek zaniżałby wynik i karta pokazywałaby brak tam, gdzie
    // jest po prostu nieuzupełniony plan.
    const planned = balance.days
      .filter((day) => day.meals > 0)
      .map((day) => this.macroValue(macro, day.planned));
    const current = planned.length
      ? Math.round(
          planned.reduce((sum, value) => sum + value, 0) / planned.length,
        )
      : 0;

    context.collectCard(
      buildMacroGapCard({
        macro,
        current,
        target,
        boosters,
        scopeLabel:
          targetUserId === context.userId ? 'ten tydzień' : member.displayName,
      }),
    );
    return { macro, current, target };
  }

  private macroTarget(
    macro: MacroKey,
    member: { targets: { calorieGoal: number; macros: unknown } },
  ): number | null {
    if (macro === 'KCAL') return member.targets.calorieGoal;
    const macros = member.targets.macros as Record<string, number> | null;
    if (!macros) return null;
    const key = { PROTEIN: 'proteinG', FAT: 'fatG', CARBS: 'carbsG' }[macro];
    const value = key ? macros[key] : undefined;
    return typeof value === 'number' ? Math.round(value) : null;
  }

  private macroValue(macro: MacroKey, planned: Record<string, number>): number {
    const key = {
      PROTEIN: 'protein',
      FAT: 'fat',
      CARBS: 'carbs',
      KCAL: 'kcal',
    }[macro];
    return Math.round(planned[key] ?? 0);
  }

  /**
   * Pełny przepis — ta sama bramka widoczności, co dla telefonu.
   *
   * `findById` z `householdId` odmawia cudzego przepisu 404-ką, tak samo jak
   * odmówiłby go użytkownikowi. Asystent nie ma tu żadnych względów: gdyby
   * czytał przepisy z pominięciem bramki, wystarczyłoby poprosić go o cudze
   * danie po identyfikatorze.
   */
  private async recipeDetails(
    input: Record<string, unknown>,
    context: AgentToolContext,
  ): Promise<RecipeDetailsForModel> {
    const ref = asString(input.recipe).trim();
    if (/^R\d+$/.test(ref) && context.catalogIndex[ref] === undefined) {
      throw new AppException(
        'RECIPE_NOT_FOUND',
        `Nie ma takiego przepisu w katalogu: ${ref}. Użyj indeksów z listy katalogu.`,
        HttpStatus.NOT_FOUND,
        [ref],
      );
    }
    const recipe = await this.recipes.findById(
      context.userId,
      this.resolveRecipeRef(ref, context),
      context.householdId,
    );
    return projectRecipeDetailsForModel(recipe);
  }

  /**
   * Wyszukiwanie dań — kryteria od modelu, reszta po stronie serwera.
   *
   * Model nie widzi katalogu (w prompcie jest tylko jego mapa), więc to jest
   * jedyna droga do dań. Filtry twarde jedzących nakłada serwis katalogu
   * tymi samymi regułami, co walidator planu; model tylko zawęża prośbą.
   * Widoczność ta sama, co w każdym odczycie przepisów: wspólny katalog
   * ALBO przepisy tego domu.
   */
  private async findRecipes(
    input: Record<string, unknown>,
    context: AgentToolContext,
  ): Promise<FindRecipesForModel> {
    const query = this.toSearchQuery(input);
    const forUserIds = (
      Array.isArray(input.for_user_ids) ? input.for_user_ids : []
    )
      .map((id) => asString(id).trim())
      .filter((id) => id.length > 0);
    const result = await this.catalog.search(
      await this.searchContext(context, forUserIds),
      query,
    );
    return this.searchResultForModel(result, context);
  }

  private toSearchQuery(input: Record<string, unknown>): RecipeSearchQuery {
    const list = (value: unknown): string[] =>
      (Array.isArray(value) ? value : [])
        .map((entry) => asString(entry).trim())
        .filter((entry) => entry.length > 0)
        .slice(0, 10);
    const limitOrNull = (value: unknown): number | null => {
      const number = typeof value === 'number' ? Math.round(value) : 0;
      return Number.isFinite(number) && number > 0 ? number : null;
    };

    const rawMeal = asString(input.meal_type);
    const mealType = (MEAL_TYPES as readonly string[]).includes(rawMeal)
      ? (rawMeal as MealType)
      : null;
    const rawTags = list(input.tags);
    const unknownTags = rawTags.filter((tag) => !isRecipeSearchTag(tag));
    if (unknownTags.length > 0) {
      throw new AppException(
        'VALIDATION_ERROR',
        `Nieznane tagi: ${unknownTags.join(', ')}. Dozwolone są tylko tagi z mapy katalogu.`,
        HttpStatus.BAD_REQUEST,
        unknownTags,
      );
    }
    const rawSort = asString(input.sort);
    const sort: SearchSort = (SEARCH_SORTS as readonly string[]).includes(
      rawSort,
    )
      ? (rawSort as SearchSort)
      : 'BEST_FIT';
    const limit = limitOrNull(input.limit) ?? SEARCH_DEFAULT_LIMIT;

    return {
      text: asString(input.query).slice(0, 200),
      mealType,
      tags: rawTags.filter(isRecipeSearchTag),
      includeIngredients: list(input.include_ingredients),
      excludeIngredients: list(input.exclude_ingredients),
      maxPrepMinutes: limitOrNull(input.max_prep_minutes),
      maxKcalPerServing: limitOrNull(input.max_kcal_per_serving),
      minProteinPerServing: limitOrNull(input.min_protein_per_serving),
      sort,
      limit: Math.min(SEARCH_MAX_LIMIT, limit),
    };
  }

  /** Kontekst wyszukiwania z tury — zgody tą samą regułą, co prompt. */
  private async searchContext(context: AgentToolContext, forUserIds: string[]) {
    // W turze: domownicy ze zgodą z pamięci tury (prompt już ich przeczytał).
    // Poza turą: sam skład domu — tańszy niż pełne profile.
    const { members } = context.memo
      ? await this.visibleMembers(context)
      : await this.prompts.membersForModel(
          await this.prisma.membership.findMany({
            where: { householdId: context.householdId },
            select: { userId: true },
          }),
        );
    return {
      userId: context.userId,
      householdId: context.householdId,
      ...(context.dates ? { weekStart: context.dates.weekStart } : {}),
      forUserIds,
      consentedUserIds: new Set(members.map((member) => member.userId)),
    };
  }

  /**
   * Referencje z indeksu TEJ tury, nie z pamięci katalogu: gdyby katalog
   * zmienił się w trakcie tury, numeracja w pamięci mogłaby rozjechać się
   * z tą, którą model zna z planu w prompcie.
   */
  private searchResultForModel(
    result: AgentSearchResult,
    context: AgentToolContext,
  ): FindRecipesForModel {
    const refById = new Map(
      Object.entries(context.catalogIndex).map(([ref, id]) => [id, ref]),
    );
    return {
      ...result,
      hits: result.hits.map((hit) => ({
        recipe: refById.get(hit.id) ?? hit.id,
        title: hit.title,
        slots: hit.slots,
        tags: hit.tags,
        kcal: hit.kcal,
        protein: hit.protein,
        prepMinutes: hit.prepMinutes,
        why: hit.why,
        ...(hit.household ? { household: true as const } : {}),
      })),
    };
  }

  /**
   * Przekazanie planiście (`AI_MODEL_TOOLS`). Do Etapu 3 wynik niósł
   * kandydatów na każdą porę domu (~7,7 tys. znaków) — po serwerowym
   * planerze dania dobiera `build_meal_plan`/`replace_plan_item`/
   * `suggest_meals`, więc planista ich nie czytał, a płacił za nie w każdej
   * kolejnej rundzie tury.
   */
  private startPlanning(): { handoff: true; note: string } {
    return {
      handoff: true,
      note:
        'Od tej rundy prowadzisz turę jako planista i masz pełny zestaw narzędzi. ' +
        'Kontekst zebrany wcześniej jest w historii — nie powtarzaj tych wywołań. ' +
        'Plan dnia albo tygodnia: build_meal_plan; jedno danie: replace_plan_item; ' +
        'dania do wyboru: suggest_meals.',
    };
  }

  /**
   * Dane dania na kartę — z bazy, przez bramkę widoczności przepisów.
   *
   * `findById` z `householdId` odmawia cudzych przepisów tak samo, jak
   * odmówiłby ich użytkownikowi. Asystent nie ma tu żadnych względów.
   */
  private async recipeSide(
    recipeId: string,
    context: AgentToolContext,
  ): Promise<
    SwapCardSide & {
      imageUrl: string | null;
      description: string | null;
      proteinGrams: number | null;
      carbsGrams: number | null;
      fatGrams: number | null;
      ingredientCount: number | null;
    }
  > {
    const recipe = await this.recipes.findById(
      context.userId,
      recipeId,
      context.householdId,
    );
    const servings = Math.max(1, recipe.servings ?? 1);
    const perServing = (value: number): number | null => {
      if (!Number.isFinite(value) || value <= 0) return null;
      return Math.round(value / servings);
    };
    return {
      recipeId,
      title: recipe.title,
      kcalPerServing: Math.round((recipe.nutritionKcal ?? 0) / servings),
      prepTimeMinutes: recipe.prepTimeMinutes ?? 0,
      imageUrl: recipe.imageUrl ?? null,
      description: recipe.description?.trim() || null,
      proteinGrams: perServing(recipe.nutritionProtein ?? 0),
      carbsGrams: perServing(recipe.nutritionCarbs ?? 0),
      fatGrams: perServing(recipe.nutritionFat ?? 0),
      ingredientCount:
        recipe.ingredients.length > 0 ? recipe.ingredients.length : null,
    };
  }

  /**
   * Propozycja jednego dnia — ta sama ścieżka co tydzień, węższe wejście.
   */
  private async proposeDayPlan(
    input: Record<string, unknown>,
    context: AgentToolContext,
    weekStart: string,
  ): Promise<CreateWeekProposalResult> {
    const dayOfWeek = asString(input.day_of_week) as DayOfWeek;
    // Sloty dnia nie niosą dnia — dokłada go serwis. Przepuszczamy je przez
    // `toSlots` z doklejonym dniem, żeby rozwiązywanie indeksów katalogu
    // (`R07` → id) i tłumaczenie nazw pól działo się w JEDNYM miejscu.
    const raw = Array.isArray(input.slots) ? input.slots : [];
    const withDay = raw.map((slot) => ({
      ...(slot as Record<string, unknown>),
      day_of_week: dayOfWeek,
    }));

    const unknownRefs = this.unknownCatalogRefs(withDay, context);
    if (unknownRefs.length > 0) {
      throw new AppException(
        'RECIPE_NOT_FOUND',
        `Nie ma takich przepisów w katalogu: ${unknownRefs.join(', ')}. Użyj indeksów z listy katalogu.`,
        HttpStatus.NOT_FOUND,
        unknownRefs,
      );
    }

    const note = asString(input.note).trim();
    return this.proposals.createDayPlanProposal({
      memo: context.memo,
      userId: context.userId,
      householdId: context.householdId,
      conversationId: context.conversationId,
      turnId: context.turnId,
      weekStart,
      dayOfWeek,
      slots: this.toSlots(withDay, context) as unknown as ApplyWeekSlotDto[],
      ...(note ? { note } : {}),
    });
  }

  /**
   * Bilans cudzej osoby = jej spożycie i makra (dane o zdrowiu). Ten sam
   * filtr zgód, co w show_macro_gap i get_household_context.
   */
  private async weekBalanceForModel(
    input: Record<string, unknown>,
    context: AgentToolContext,
    weekStart: string,
  ) {
    const memberUserId = input.member_user_id
      ? asString(input.member_user_id)
      : undefined;
    if (memberUserId && memberUserId !== context.userId) {
      const { members } = await this.visibleMembers(context);
      if (!members.some((member) => member.userId === memberUserId)) {
        throw new AppException(
          'VALIDATION_ERROR',
          'Ta osoba nie wyraziła zgody na asystenta — jej bilansu nie ma w narzędziach.',
          HttpStatus.BAD_REQUEST,
          ['member_user_id'],
        );
      }
    }
    return this.weeklyPlans.weeklyBalance(
      context.userId,
      context.householdId,
      weekStart,
      memberUserId,
    );
  }

  private async proposeWeekPlan(
    input: Record<string, unknown>,
    context: AgentToolContext,
    weekStart: string,
  ): Promise<CreateWeekProposalResult> {
    const unknownRefs = this.unknownCatalogRefs(input.slots, context);
    if (unknownRefs.length > 0) {
      throw new AppException(
        'RECIPE_NOT_FOUND',
        `Nie ma takich przepisów w katalogu: ${unknownRefs.join(', ')}. Użyj indeksów z listy katalogu.`,
        HttpStatus.NOT_FOUND,
        unknownRefs,
      );
    }

    const note = asString(input.note).trim();
    const removalReasons = this.toRemovalReasons(input.removals);
    return this.proposals.createWeekPlanProposal({
      memo: context.memo,
      userId: context.userId,
      householdId: context.householdId,
      conversationId: context.conversationId,
      turnId: context.turnId,
      weekStart,
      slots: this.toSlots(
        input.slots,
        context,
      ) as unknown as ApplyWeekSlotDto[],
      ...(note ? { note } : {}),
      ...(removalReasons.length > 0 ? { removalReasons } : {}),
    });
  }

  /**
   * Poprawka jednego slotu w propozycji, która czeka na zatwierdzenie.
   *
   * Model podaje numer propozycji (z dopisku w historii), slot i danie —
   * resztę tygodnia bierze serwis z INTENCJI tamtej propozycji
   * (`action.slots`), więc model nie ma jak zgubić pozycji, których nie
   * wypisał. Schemat bez `strict` (budżet pól 24/24 i gramatyka), więc
   * dzień i porę sprawdzamy tutaj.
   */
  private async reviseProposal(
    input: Record<string, unknown>,
    context: AgentToolContext,
  ): Promise<CreateWeekProposalResult> {
    const dayOfWeek = asString(input.day_of_week);
    const mealType = asString(input.meal_type);
    if (
      !(Object.values(DayOfWeek) as string[]).includes(dayOfWeek) ||
      !(Object.values(MealType) as string[]).includes(mealType)
    ) {
      throw new AppException(
        'VALIDATION_ERROR',
        'day_of_week to MON…SUN, a meal_type to jedna z pór z listy.',
        HttpStatus.BAD_REQUEST,
        ['day_of_week', 'meal_type'],
      );
    }
    const unknownRefs = this.unknownCatalogRefs([input], context);
    if (unknownRefs.length > 0) {
      throw new AppException(
        'RECIPE_NOT_FOUND',
        `Nie ma takich przepisów w katalogu: ${unknownRefs.join(', ')}. Użyj indeksów z listy katalogu.`,
        HttpStatus.NOT_FOUND,
        unknownRefs,
      );
    }
    return this.proposals.reviseProposal({
      memo: context.memo,
      userId: context.userId,
      householdId: context.householdId,
      conversationId: context.conversationId,
      turnId: context.turnId,
      proposalId: asString(input.proposal_id).trim(),
      dayOfWeek: dayOfWeek as DayOfWeek,
      mealType: mealType as MealType,
      recipeId: this.resolveRecipeRef(asString(input.recipe), context),
    });
  }

  /**
   * Serwerowy planer — plan dni × pór (Etap 2E). Model podaje zakres
   * i życzenia, dania, porcje i bilans liczy serwer; wynik idzie tą samą
   * ścieżką propozycji, co `propose_week_plan`/`propose_day_plan` (walidacja
   * zapisu, karta, odcisk planu, kliknięcie człowieka).
   */
  private async buildMealPlan(
    input: Record<string, unknown>,
    context: AgentToolContext,
    weekStart: string,
  ) {
    const days = enumList(input.days, Object.values(DayOfWeek), 'days');
    if (days.length === 0) {
      throw new AppException(
        'VALIDATION_ERROR',
        'days: podaj co najmniej jeden dzień (MON…SUN).',
        HttpStatus.BAD_REQUEST,
        ['days'],
      );
    }
    const outcome = await this.planner.build({
      userId: context.userId,
      householdId: context.householdId,
      weekStart,
      days,
      mealTypes: enumList(
        input.meal_types,
        Object.values(MealType),
        'meal_types',
      ),
      forUserIds: stringList(input.for_user_ids),
      wishes: wishesOf(input),
      seed: context.turnId,
      memo: context.memo,
    });
    const diagnostics = plannerResultForModel(outcome);
    if (outcome.draft.items.length === 0) {
      return { proposed: false as const, planner: diagnostics };
    }
    const note = '';
    const proposal =
      days.length === 1
        ? await this.proposals.createDayPlanProposal({
            memo: context.memo,
            userId: context.userId,
            householdId: context.householdId,
            conversationId: context.conversationId,
            turnId: context.turnId,
            weekStart,
            dayOfWeek: days[0],
            slots: outcome.targetSlots
              .filter((slot) => slot.dayOfWeek === days[0])
              .map(({ dayOfWeek: _day, ...slot }) => slot),
          })
        : await this.proposals.createWeekPlanProposal({
            memo: context.memo,
            userId: context.userId,
            householdId: context.householdId,
            conversationId: context.conversationId,
            turnId: context.turnId,
            weekStart,
            slots: outcome.targetSlots,
            ...(note ? { note } : {}),
          });
    return { ...proposal, planner: diagnostics };
  }

  /**
   * Dania do wyboru z serwera (Etap 3) — „co na kolację?", „3 szybkie
   * kolacje", „mam dużo kurczaka". Jedna operacja zamiast `find_recipes` →
   * analiza modelu → `offer_options`: serwer filtruje (alergeny, diety,
   * wykluczenia wszystkich jedzących), rankinguje wobec tego, co osobie
   * zostaje na ten posiłek przy reszcie dnia, różnicuje i stawia TĘ SAMĄ
   * kartę OPTIONS co `offer_options` — więc „wybieram drugą" działa bez zmian.
   */
  private async suggestMeals(
    input: Record<string, unknown>,
    context: AgentToolContext,
    weekStart: string,
  ) {
    const [dayOfWeek] = enumList(
      [input.day_of_week],
      Object.values(DayOfWeek),
      'day_of_week',
    );
    const [mealType] = enumList(
      [input.meal_type],
      Object.values(MealType),
      'meal_type',
    );
    const rawCount =
      typeof input.count === 'number' ? Math.round(input.count) : 3;
    const count = Math.min(MAX_OPTIONS, Math.max(2, rawCount || 3));
    const wishes = wishesOf(input);
    const outcome = await this.planner.suggest({
      userId: context.userId,
      householdId: context.householdId,
      weekStart,
      dayOfWeek,
      mealType,
      forUserIds: stringList(input.for_user_ids),
      wishes,
      includeIngredients: stringList(input.include_ingredients).slice(0, 5),
      count,
      seed: context.turnId,
      memo: context.memo,
    });
    const { draft } = outcome;
    const budget = draft.slotBudget.find(
      (entry) => entry.userId === context.userId,
    );
    const common = {
      status: draft.status,
      eligible: draft.eligible,
      // Z PLANU (zaplanowane, nie odhaczone): ile kcal zostaje pytającemu
      // na ten posiłek przy reszcie dnia.
      ...(budget ? { remainingKcalForMeal: budget.kcal } : {}),
      ...(draft.relaxed.length > 0 ? { relaxed: draft.relaxed } : {}),
    };
    if (draft.suggestions.length < 2) {
      // Jedno danie to nie wybór — karty nie ma, model mówi, czego zabrakło.
      return {
        proposed: false as const,
        offered: 0,
        ...common,
        hint: 'Za mało dań spełnia warunki. Zdejmij jedno życzenie (np. składnik albo tag) albo powiedz to użytkownikowi.',
      };
    }

    const sides = await Promise.all(
      draft.suggestions.map((entry) =>
        this.recipeSide(entry.item.recipeId, context),
      ),
    );
    const tags = optionTags(
      sides.map((side) => ({
        prep: side.prepTimeMinutes,
        protein: side.proteinGrams ?? 0,
      })),
    );
    const options: OptionsCardItem[] = sides.map((side, index) => ({
      recipeId: side.recipeId,
      title: side.title,
      kcalPerServing: side.kcalPerServing,
      prepTimeMinutes: side.prepTimeMinutes,
      imageUrl: side.imageUrl,
      description: side.description,
      proteinGrams: side.proteinGrams,
      carbsGrams: side.carbsGrams,
      fatGrams: side.fatGrams,
      ingredientCount: side.ingredientCount,
      tag: tags[index],
      prompt: optionPrompt(side.title),
    }));
    const quick =
      wishes.maxPrepMinutes !== null || wishes.preferredTags.includes('quick');
    context.collectCard(
      buildOptionsCard({
        title: `${NUMERALS[options.length] ?? options.length} ${quick ? 'szybkie ' : ''}propozycje`,
        options,
        slotLabel: `${MEAL_LABELS[mealType]} · ${DAY_LABELS[dayOfWeek].toLowerCase()}`,
      }),
    );
    const refById = new Map(
      Object.entries(context.catalogIndex).map(([ref, id]) => [id, ref]),
    );
    return {
      offered: options.length,
      ...common,
      options: sides.map((side) => ({
        recipe: refById.get(side.recipeId) ?? side.recipeId,
        title: side.title,
        kcal: side.kcalPerServing,
        prepMinutes: side.prepTimeMinutes,
      })),
    };
  }

  /**
   * Serwerowy planer — jedno danie (Etap 2D). W propozycji PENDING idzie
   * przez `reviseProposal` (reszta z intencji propozycji, porcje z planera),
   * w zapisanym planie — przez kartę podmiany (`proposeSwap`), która pokazuje
   * „przed/po". Planer dostaje całą resztę tygodnia jako `fixed`.
   */
  private async replacePlanItem(
    input: Record<string, unknown>,
    context: AgentToolContext,
    weekStart: string,
  ) {
    const [dayOfWeek] = enumList(
      [input.day_of_week],
      Object.values(DayOfWeek),
      'day_of_week',
    );
    const [mealType] = enumList(
      [input.meal_type],
      Object.values(MealType),
      'meal_type',
    );
    const proposalId = asString(input.proposal_id).trim();
    const pending = proposalId
      ? await this.proposals.loadPendingPlanProposal({
          proposalId,
          conversationId: context.conversationId,
          householdId: context.householdId,
        })
      : null;
    const week = pending?.weekStart ?? weekStart;
    const currentSlots =
      pending?.slots ??
      (await this.weeklyPlans.snapshotWeekAsSlots(
        context.userId,
        context.householdId,
        week,
      ));
    const outcome = await this.planner.replace({
      userId: context.userId,
      householdId: context.householdId,
      weekStart: week,
      dayOfWeek,
      mealType,
      currentSlots,
      wishes: wishesOf(input),
      similarKcal: input.similar_kcal === true,
      // Karta podmiany zapisuje porcje z audytorium — planer ma liczyć tak samo.
      portionMode: pending ? 'tune' : 'auto',
      seed: context.turnId,
      memo: context.memo,
    });
    const diagnostics = plannerResultForModel(outcome);
    const [chosen] = outcome.draft.items;
    if (!chosen) return { proposed: false as const, planner: diagnostics };
    const proposal = pending
      ? await this.proposals.reviseProposal({
          memo: context.memo,
          userId: context.userId,
          householdId: context.householdId,
          conversationId: context.conversationId,
          turnId: context.turnId,
          proposalId,
          dayOfWeek,
          mealType,
          recipeId: chosen.recipeId,
          plannedServings: chosen.plannedServings,
          ...(chosen.portions?.length ? { portions: chosen.portions } : {}),
        })
      : await this.proposeSwap(
          {
            day_of_week: dayOfWeek,
            meal_type: mealType,
            recipe: chosen.recipeId,
          },
          context,
          week,
          chosen.portions,
        );
    return { ...proposal, planner: diagnostics };
  }

  /** Powody usunięć od modelu — bez walidacji slotów, dopasowanie robi karta. */
  private toRemovalReasons(raw: unknown): PlanRemovalReason[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((entry) => (entry ?? {}) as Record<string, unknown>)
      .map((entry) => ({
        dayOfWeek: asString(
          entry.day_of_week,
        ) as PlanRemovalReason['dayOfWeek'],
        mealType: asString(entry.meal_type) as PlanRemovalReason['mealType'],
        reason: asString(entry.reason).trim().slice(0, 40),
      }))
      .filter((entry) => entry.dayOfWeek && entry.mealType && entry.reason);
  }

  private async applyWeekPlan(
    input: Record<string, unknown>,
    context: AgentToolContext,
    weekStart: string,
  ): Promise<ApplyWeekPlanForModel> {
    // Zmyślony indeks katalogu zatrzymujemy TUTAJ, a nie w walidacji DTO.
    // Przepuszczony dalej wróciłby jako „recipeId must be a UUID" — model
    // mówi indeksami (`R07`), więc taki komunikat nic mu nie mówi i pętla
    // kręciłaby się w kółko. Tu dostaje wprost, którego indeksu nie ma.
    const unknownRefs = this.unknownCatalogRefs(input.slots, context);
    if (unknownRefs.length > 0) {
      throw new AppException(
        'RECIPE_NOT_FOUND',
        `Nie ma takich przepisów w katalogu: ${unknownRefs.join(', ')}. Użyj indeksów z listy katalogu.`,
        HttpStatus.NOT_FOUND,
        unknownRefs,
      );
    }
    // Rzutowanie przez `unknown`: to jest wejście MODELU, a nie nasze DTO.
    // Kształt sprawdza `validateDto` w serwisie — tu tylko tłumaczymy
    // nazwy pól z konwencji narzędzi (snake_case) na naszą.
    const dryRun = input.dry_run === true;
    const payload: unknown = {
      dryRun,
      slots: this.toSlots(input.slots, context),
    };
    const run = (): Promise<ApplyWeekPlanResult> =>
      this.weeklyPlans.applyWeekPlan(
        context.userId,
        context.householdId,
        weekStart,
        payload as ApplyWeekPlanDto,
      );

    if (dryRun) return this.applyResultForModel(await run(), context);

    const plan = await this.counters.resolvePlan(context.householdId, {
      userId: context.userId,
    });
    const periodKey = plan.periodKey;
    // TA SAMA PULA, CO PRZY PROPOZYCJI. Zapis planu schodzi dziś dwiema
    // drogami — narzędziem modelu (tu) i zatwierdzeniem karty
    // (`agent-proposals.service`) — a ta druga liczyła na `plan.quotaScopeId`.
    // Dwa różne zakresy znaczyły dwie osobne pule na jeden sprzedany limit:
    // dom z Solo miał osiem zapisów narzędziem I osiem kartą.
    const scopeId = plan.quotaScopeId;
    const limit = plan.plansLimit;
    const consumed = await this.counters.tryConsume(
      this.prisma,
      scopeId,
      periodKey,
      'plans',
      limit,
    );
    if (!consumed) {
      this.metrics.recordRejected('planQuota');
      throw new AppException(
        'AI_PLAN_QUOTA_EXCEEDED',
        (plan.tier === 'TRIAL'
          ? `Darmowy zapis planu na próbę (${limit}) jest wykorzystany. `
          : `Limit zapisanych planów w tym okresie (${limit}) został wyczerpany. `) +
          'Możesz jeszcze zaproponować plan i pokazać go w odpowiedzi, ale nie zapiszesz go' +
          (plan.tier === 'TRIAL'
            ? ' bez wybrania planu.'
            : ' do odnowienia planu.'),
        HttpStatus.TOO_MANY_REQUESTS,
        this.counters.quotaDetailsFor('plans', plan),
      );
    }

    try {
      const result = await run();
      const changed =
        result.changes.created +
        result.changes.updated +
        result.changes.deleted;
      if (!result.applied || changed === 0)
        await this.refundPlan(scopeId, periodKey);
      return this.applyResultForModel(result, context);
    } catch (error) {
      await this.refundPlan(scopeId, periodKey);
      throw error;
    }
  }

  /** Zwrot kwoty planu — nigdy nie wywraca narzędzia, bo to tylko księgowość. */
  private async refundPlan(scopeId: string, periodKey: string): Promise<void> {
    try {
      await this.counters.add(this.prisma, scopeId, periodKey, 'plans', -1);
    } catch (error) {
      this.logger.error(
        'nie udało się zwrócić kwoty planu',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Zamienia `recipe` z narzędzia na identyfikator z bazy.
   *
   * Model dostaje katalog jako krótkie indeksy (`R07`), bo UUID kosztuje
   * 20–25 tokenów i tak czy owak zostałby przekręcony. Wszystko, co nie jest
   * indeksem, przepuszczamy dalej jako identyfikator przepisu gospodarstwa —
   * jeśli jest zmyślony, zatrzyma go walidacja `applyWeekPlan` i wróci jako
   * naruszenie, które model umie poprawić.
   */
  private resolveRecipeRef(value: string, context: AgentToolContext): string {
    return context.catalogIndex[value] ?? value;
  }

  /** Indeksy w kształcie `R07`, których nie ma w digeście tej tury. */
  private unknownCatalogRefs(
    slots: unknown,
    context: AgentToolContext,
  ): string[] {
    if (!Array.isArray(slots)) return [];
    const refs = slots.map((raw) =>
      asString((raw as Record<string, unknown>)?.recipe),
    );
    return Array.from(
      new Set(
        refs.filter(
          (ref) =>
            /^R\d+$/.test(ref) && context.catalogIndex[ref] === undefined,
        ),
      ),
    );
  }

  private toSlots(
    slots: unknown,
    context: AgentToolContext,
  ): { [key: string]: unknown }[] {
    if (!Array.isArray(slots)) return [];
    return slots.map((raw) => {
      const slot = (raw ?? {}) as Record<string, unknown>;
      // Uczestnicy od modelu; brak listy znaczy „całe gospodarstwo".
      const participantIds = Array.isArray(slot.participant_user_ids)
        ? (slot.participant_user_ids as string[])
        : [];

      return {
        dayOfWeek: slot.day_of_week,
        mealType: slot.meal_type,
        recipeId: this.resolveRecipeRef(asString(slot.recipe), context),
        ...(participantIds.length > 0 ? { participantIds } : {}),
        ...(typeof slot.planned_servings === 'number'
          ? { plannedServings: slot.planned_servings }
          : {}),
      };
    });
  }

  private toIngredients(value: unknown): Record<string, unknown>[] {
    if (!Array.isArray(value)) return [];
    return value.map((raw) => {
      const item = (raw ?? {}) as Record<string, unknown>;
      return {
        ingredientId: item.ingredient_id,
        amount: item.amount,
        unit: item.unit,
      };
    });
  }

  private toSteps(value: unknown): { text: string }[] | undefined {
    if (!Array.isArray(value)) return undefined;
    return value.map((raw) => ({
      text: asString((raw as Record<string, unknown>)?.text),
    }));
  }
}

/**
 * Lista wartości z enuma; nieznana wartość = błąd dla modelu (schemat bez
 * `strict`, więc sprawdzamy tutaj). Duplikaty znikają.
 */
function enumList<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  field: string,
): T[] {
  const values = Array.isArray(raw) ? raw : [];
  const bad = values.filter(
    (value) => typeof value !== 'string' || !allowed.includes(value as T),
  );
  if (bad.length > 0) {
    throw new AppException(
      'VALIDATION_ERROR',
      `${field}: dozwolone ${allowed.join(', ')}.`,
      HttpStatus.BAD_REQUEST,
      [field],
    );
  }
  return [...new Set(values as T[])];
}

function stringList(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === 'string')
    : [];
}

/** Życzenia planera z wejścia narzędzia — „brak" to [], NONE albo 0. */
function wishesOf(input: Record<string, unknown>): PlannerWishes {
  const diet = enumList(
    input.diet === undefined ? [] : [input.diet],
    Object.values(DietPreferenceValue),
    'diet',
  )[0];
  const tags = (raw: unknown, field: string) => {
    const values = stringList(raw);
    const bad = values.filter((value) => !isRecipeSearchTag(value));
    if (bad.length > 0) {
      throw new AppException(
        'VALIDATION_ERROR',
        `${field}: nieznane tagi ${bad.join(', ')}.`,
        HttpStatus.BAD_REQUEST,
        [field],
      );
    }
    return values;
  };
  const maxPrep =
    typeof input.max_prep_minutes === 'number' && input.max_prep_minutes > 0
      ? Math.round(input.max_prep_minutes)
      : null;
  return {
    diet: diet && diet !== 'NONE' ? diet : null,
    requiredTags: tags(input.must_have_tags, 'must_have_tags'),
    preferredTags: tags(input.prefer_tags, 'prefer_tags'),
    avoidIngredients: stringList(input.avoid_ingredients).slice(0, 10),
    maxPrepMinutes: maxPrep,
  };
}

const NUMERALS: Record<number, string> = { 2: 'Dwie', 3: 'Trzy', 4: 'Cztery' };

/** „na kolację", „na drugie śniadanie" — do zdań serwera. */
const MEAL_FOR: Record<MealType, string> = {
  BREAKFAST: 'na śniadanie',
  SECOND_BREAKFAST: 'na drugie śniadanie',
  LUNCH: 'na obiad',
  AFTERNOON_SNACK: 'na podwieczorek',
  DINNER: 'na kolację',
  SNACK: 'na przekąskę',
};

/** Biernik dnia: „w środę", „na sobotę". */
const DAY_ACCUSATIVE: Record<DayOfWeek, string> = {
  MON: 'poniedziałek',
  TUE: 'wtorek',
  WED: 'środę',
  THU: 'czwartek',
  FRI: 'piątek',
  SAT: 'sobotę',
  SUN: 'niedzielę',
};

/**
 * Wyróżnik kafelka z danych, nie od modelu: pierwsze = najlepiej pasuje,
 * potem najszybsze i najbardziej białkowe — każdy napis najwyżej raz.
 */
function optionTags(
  sides: readonly { prep: number; protein: number }[],
): (string | null)[] {
  const tags: (string | null)[] = sides.map((_, index) =>
    index === 0 ? 'Najlepiej pasuje' : null,
  );
  const pick = (score: (side: { prep: number; protein: number }) => number) => {
    let best = -1;
    sides.forEach((side, index) => {
      if (tags[index] !== null) return;
      if (best === -1 || score(side) > score(sides[best])) best = index;
    });
    return best;
  };
  const quickest = pick((side) => -side.prep);
  if (quickest > 0 && sides[quickest].prep < sides[0].prep) {
    tags[quickest] = 'Najszybsze';
  }
  const protein = pick((side) => side.protein);
  if (protein > 0 && sides[protein].protein > sides[0].protein) {
    tags[protein] = 'Najwięcej białka';
  }
  return tags;
}

/**
 * Zdanie SERWERA kończące turę, gdy model nie napisał nic przed kartą
 * (Etap 3.3). Karta pokazuje dania, liczby i przyciski, więc zdanie tylko
 * nazywa, co widać, i co zrobić dalej. `null` = model ma coś do wyjaśnienia
 * (plan PARTIAL, pytanie bez treści) i dostaje kolejną rundę jak dotąd.
 */
export function turnTextFor(
  name: string,
  input: Record<string, unknown>,
  data: unknown,
): string | null {
  const result = (data ?? {}) as {
    offered?: number;
    planner?: { status?: string };
  };
  const day = DAY_ACCUSATIVE[asString(input.day_of_week) as DayOfWeek];
  const meal = MEAL_FOR[asString(input.meal_type) as MealType];
  switch (name) {
    case 'suggest_meals': {
      const count = NUMERALS[result.offered ?? 0];
      if (!count || !meal) return null;
      return `${count} propozycje ${meal}${day ? ` w ${day}` : ''} — wybierz jedną.`;
    }
    case 'offer_options':
      return 'Wybierz jedno z dań.';
    case 'build_meal_plan': {
      if (result.planner?.status !== 'OK') return null;
      const days = Array.isArray(input.days) ? input.days : [];
      const only =
        days.length === 1
          ? DAY_ACCUSATIVE[asString(days[0]) as DayOfWeek]
          : null;
      return only
        ? `Plan na ${only} gotowy — zatwierdzisz go jednym kliknięciem.`
        : 'Plan tygodnia gotowy — zatwierdzisz go jednym kliknięciem.';
    }
    case 'replace_plan_item':
      return result.planner?.status === 'OK'
        ? 'Nowe danie czeka na zatwierdzenie w karcie.'
        : null;
    case 'revise_proposal':
      return 'Poprawiona propozycja czeka na zatwierdzenie.';
    case 'propose_swap':
      return 'Podmiana czeka na zatwierdzenie.';
    case 'propose_remove_meal':
      return 'Usunięcie czeka na zatwierdzenie.';
    case 'propose_day_plan':
    case 'propose_week_plan':
      return 'Propozycja czeka na zatwierdzenie.';
    case 'propose_household_split':
      return 'Jedno danie dla wszystkich — jak podać je każdemu, masz w karcie.';
    case 'ask_clarifying_question': {
      const question = asString(input.question).trim();
      return question.length > 0 ? question : null;
    }
    default:
      return null;
  }
}
