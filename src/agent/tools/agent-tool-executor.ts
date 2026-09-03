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
import { AGENT_TOOL_NAMES } from './agent-tools';
import {
  AgentProposalsService,
  CreateWeekProposalResult,
} from '../proposals/agent-proposals.service';
import { AgentCard, PlanRemovalReason } from '../cards/agent-cards';
import { AgentPromptService } from '../agent-prompt.service';
import { buildClarifyCard, MAX_CLARIFY_OPTIONS } from '../cards/clarify-card';
import {
  buildOptionsCard,
  MAX_OPTIONS,
  optionPrompt,
} from '../cards/options-card';
import {
  MacroGapBooster,
  MacroKey,
  OptionsCardItem,
  SwapCardSide,
} from '../cards/agent-cards';
import { buildMacroGapCard, MAX_BOOSTERS } from '../cards/macro-gap-card';
import { buildShoppingListCard } from '../cards/shopping-list-card';
import { ShoppingListService } from '../../weekly-plans/services/shopping-list.service';
import { ShoppingDepartment } from '../../weekly-plans/types/shopping-department.enum';
import { DayOfWeek, MealType } from '@prisma/client';

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
 */
const REDACTED_VIOLATION_MESSAGES: Record<string, string> = {
  RECIPE_ALLERGEN_CONFLICT:
    'Danie zawiera alergen któregoś z jedzących — wybierz inne danie na ten slot.',
  RECIPE_EXCLUDED_INGREDIENT:
    'Danie zawiera składnik, którego ktoś z jedzących nie je — wybierz inne danie.',
};

export function redactViolationsForModel<T>(result: T): T {
  if (!result || typeof result !== 'object') return result;
  const record = result as Record<string, unknown>;
  if (!Array.isArray(record.violations)) return result;
  const violations = record.violations as unknown[];
  return {
    ...record,
    violations: violations.map((violation): unknown => {
      if (!violation || typeof violation !== 'object') return violation;
      const entry = violation as { code?: string; message?: string };
      const redacted = entry.code
        ? REDACTED_VIOLATION_MESSAGES[entry.code]
        : null;
      return redacted ? { ...entry, message: redacted } : violation;
    }),
  } as T;
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
   * Kogo dotyczy pytanie — wybór użytkownika zrobiony PRZED wysłaniem.
   *
   * Puste = całe gospodarstwo. To NIE jest podpowiedź dla modelu, tylko
   * wartość domyślna audytorium: gdy model nie poda uczestników, posiłek
   * dostają wybrane osoby, a nie cały dom. Odwrotna kolejność (model
   * decyduje, zakres doradza) kończyła się tym, że „chcę inne śniadanie niż
   * Gaba" zmieniało śniadanie CAŁEMU domowi.
   */
  scopeUserIds: string[];
  /**
   * Karta, która NIE zapisuje niczego (pytanie, zestawienie, wybór).
   *
   * Propozycje idą przez bazę, bo muszą przeżyć pad procesu i dać się
   * zatwierdzić kwadrans później. Karta bez skutków ubocznych nie ma czego
   * przeżywać: gdy tura padnie, nie powstaje żadna wiadomość, więc nie ma
   * jej gdzie pokazać. Wiersz w bazie byłby tu wyłącznie kosztem.
   */
  collectCard: (card: AgentCard) => void;
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
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string; details?: string[] } };

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
    // Filtr zgód domowników — ta sama reguła, co przy budowie promptu.
    private readonly prompts: AgentPromptService,
  ) {}

  async execute(
    name: string,
    input: Record<string, unknown>,
    context: AgentToolContext,
  ): Promise<AgentToolResult> {
    if (!AGENT_TOOL_NAMES.includes(name)) {
      // Model wywołał narzędzie, którego nie ma na liście. Zdarza się rzadko,
      // ale odpowiedź musi być danymi — inaczej tura pada przez literówkę.
      return this.failure('BAD_REQUEST', `Nie ma narzędzia o nazwie ${name}.`);
    }

    const refusal = this.refuseOutOfMode(name, context);
    if (refusal) return refusal;

    try {
      return {
        ok: true,
        data: redactViolationsForModel(
          await this.dispatch(name, input, context),
        ),
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
  private refuseOutOfMode(
    name: string,
    context: AgentToolContext,
  ): AgentToolResult | null {
    if (name === 'apply_week_plan' && context.proposalMode) {
      return this.failure(
        'AI_TOOL_NOT_IN_MODE',
        'W tym trybie nie zapisujesz planu sam. Podaj ten sam stan docelowy przez ' +
          'propose_week_plan — użytkownik zatwierdzi go jednym kliknięciem w aplikacji.',
      );
    }
    if (
      (name === 'propose_week_plan' ||
        name === 'propose_day_plan' ||
        name === 'propose_swap' ||
        name === 'propose_household_split') &&
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
      case 'get_household_context':
        // Ten sam filtr zgód, co w prompcie: model widzi tylko domowników,
        // którzy sami zgodzili się na asystenta.
        return this.households
          .memberPreferences(userId, householdId)
          .then((all) => this.prompts.membersForModel(all))
          .then((result) => result.members);

      case 'get_week_plan':
        return this.weeklyPlans.getByHouseholdAndWeek(
          userId,
          householdId,
          str('week_start'),
        );

      case 'get_week_balance':
        return this.weekBalanceForModel(input, context, str('week_start'));

      case 'search_ingredients':
        return this.ingredients.search({
          query: str('query'),
          onlyWithNutrition: input.only_with_nutrition === true,
          ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
        });

      case 'ask_clarifying_question':
        return Promise.resolve(this.askClarifyingQuestion(input, context));

      case 'offer_options':
        return this.offerOptions(input, context);

      case 'propose_swap':
        return this.proposeSwap(input, context, str('week_start'));

      case 'propose_household_split':
        return this.proposeHouseholdSplit(input, context, str('week_start'));

      case 'show_macro_gap':
        return this.showMacroGap(input, context, str('week_start'));

      case 'check_plan_conflicts':
        return this.checkPlanConflicts(context, str('week_start'));

      case 'show_shopping_list':
        return this.showShoppingList(context, str('week_start'));

      case 'propose_day_plan':
        return this.proposeDayPlan(input, context, str('week_start'));

      case 'propose_week_plan':
        return this.proposeWeekPlan(input, context, str('week_start'));

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
        return this.recipes.create(userId, payload as CreateRecipeDto);
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
        return this.recipes.update(
          userId,
          str('recipe_id'),
          payload as UpdateRecipeDto,
        );
      }

      case 'remember_note':
        return this.memory.remember(
          householdId,
          userId,
          str('text'),
          asString(input.kind) || undefined,
        );

      case 'start_planning':
        // Sama zmiana modelu dzieje się w dostawcy (patrz AgentProviderHandoff);
        // tu wystarczy potwierdzenie, które planista przeczyta jako pierwsze.
        return Promise.resolve({
          handoff: true,
          note:
            'Od tej rundy prowadzisz turę jako planista i masz pełny zestaw narzędzi ' +
            '(propose_*, apply_*). Kontekst zebrany wcześniej jest w historii — nie ' +
            'powtarzaj tych wywołań.',
        });

      case 'delete_recipe':
        return this.recipes.remove(userId, str('recipe_id'), householdId);

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
    const participantIds = Array.isArray(input.participant_user_ids)
      ? (input.participant_user_ids as string[])
      : context.scopeUserIds;

    return this.proposals.createSwapProposal({
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
    const withScope =
      portions.length > 0
        ? portions
        : context.scopeUserIds.map((userId) => ({ userId, note: null }));
    if (withScope.length === 0) {
      throw new AppException(
        'VALIDATION_ERROR',
        'Podaj, kto je to danie — bez tego karta nie ma o czym mówić.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const recipeId = this.resolveRecipeRef(ref, context);
    return this.proposals.createHouseholdSplitProposal({
      userId: context.userId,
      householdId: context.householdId,
      conversationId: context.conversationId,
      turnId: context.turnId,
      weekStart,
      dayOfWeek: asString(input.day_of_week) as DayOfWeek,
      mealType: asString(input.meal_type) as MealType,
      recipeId,
      dish: await this.recipeSide(recipeId, context),
      portions: withScope,
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
   */
  private async checkPlanConflicts(
    context: AgentToolContext,
    weekStart: string,
  ): Promise<{
    weekStart: string;
    checkedSlots: number;
    conflicts: {
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
      return { weekStart, checkedSlots: 0, conflicts: [] };
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
      conflicts: preview.violations.map((violation) => ({
        dayOfWeek: violation.dayOfWeek,
        mealType: violation.mealType,
        code: violation.code,
        message: violation.message,
      })),
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
      this.households
        .memberPreferences(context.userId, context.householdId)
        .then((all) => this.prompts.membersForModel(all))
        .then((result) => result.members),
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
   * Dane dania na kartę — z bazy, przez bramkę widoczności przepisów.
   *
   * `findById` z `householdId` odmawia cudzych przepisów tak samo, jak
   * odmówiłby ich użytkownikowi. Asystent nie ma tu żadnych względów.
   */
  private async recipeSide(
    recipeId: string,
    context: AgentToolContext,
  ): Promise<SwapCardSide & { imageUrl: string | null }> {
    const recipe = await this.recipes.findById(
      context.userId,
      recipeId,
      context.householdId,
    );
    const servings = Math.max(1, recipe.servings ?? 1);
    return {
      recipeId,
      title: recipe.title,
      kcalPerServing: Math.round((recipe.nutritionKcal ?? 0) / servings),
      prepTimeMinutes: recipe.prepTimeMinutes ?? 0,
      imageUrl: recipe.imageUrl ?? null,
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
      const all = await this.households.memberPreferences(
        context.userId,
        context.householdId,
      );
      const { members } = await this.prompts.membersForModel(all);
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
  ): Promise<ApplyWeekPlanResult> {
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

    if (dryRun) return run();

    const plan = await this.counters.resolvePlan(context.householdId, {
      userId: context.userId,
    });
    const periodKey = plan.periodKey;
    const limit = plan.plansLimit;
    const consumed = await this.counters.tryConsume(
      this.prisma,
      context.householdId,
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
          : `Limit zapisanych planów na ten miesiąc (${limit}) został wyczerpany. `) +
          'Możesz jeszcze zaproponować plan i pokazać go w odpowiedzi, ale nie zapiszesz go' +
          (plan.tier === 'TRIAL' ? ' bez PRO.' : ' do końca miesiąca.'),
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
        await this.refundPlan(context, periodKey);
      return result;
    } catch (error) {
      await this.refundPlan(context, periodKey);
      throw error;
    }
  }

  /** Zwrot kwoty planu — nigdy nie wywraca narzędzia, bo to tylko księgowość. */
  private async refundPlan(
    context: AgentToolContext,
    periodKey: string,
  ): Promise<void> {
    try {
      await this.counters.add(
        this.prisma,
        context.householdId,
        periodKey,
        'plans',
        -1,
      );
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
      // Uczestnicy od modelu, a gdy ich nie podał — z zakresu pytania.
      // Pusta tablica z obu stron znaczy „całe gospodarstwo" i tak zostaje.
      const participantIds = Array.isArray(slot.participant_user_ids)
        ? (slot.participant_user_ids as string[])
        : context.scopeUserIds;

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
