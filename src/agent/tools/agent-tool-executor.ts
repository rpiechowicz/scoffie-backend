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
import { readAgentEnv } from '../../config/agent-env';
import { AgentMemoryService } from '../agent-memory.service';
import { AiUsageCountersService } from '../ai-usage-counters.service';
import { CreateRecipeDto } from '../../recipes/dto/create-recipe.dto';
import { UpdateRecipeDto } from '../../recipes/dto/update-recipe.dto';
import { AGENT_TOOL_NAMES } from './agent-tools';
import {
  AgentProposalsService,
  CreateWeekProposalResult,
} from '../proposals/agent-proposals.service';

/**
 * Kontekst tury: kto pyta i o które gospodarstwo.
 *
 * Model NIE dostaje tych wartości i nie może ich podać — bierzemy je z tury,
 * dokładnie tak, jak handlery WS biorą tożsamość z socketu, a nie z payloadu.
 * Gdyby `household_id` był polem narzędzia, wystarczyłoby, żeby model je
 * zmyślił, i asystent pisałby po cudzym planie.
 */
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
      return { ok: true, data: await this.dispatch(name, input, context) };
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
    if (name === 'propose_week_plan' && !context.proposalMode) {
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
        return this.households.memberPreferences(userId, householdId);

      case 'get_week_plan':
        return this.weeklyPlans.getByHouseholdAndWeek(
          userId,
          householdId,
          str('week_start'),
        );

      case 'get_week_balance':
        return this.weeklyPlans.weeklyBalance(
          userId,
          householdId,
          str('week_start'),
          input.member_user_id ? str('member_user_id') : undefined,
        );

      case 'search_ingredients':
        return this.ingredients.search({
          query: str('query'),
          onlyWithNutrition: input.only_with_nutrition === true,
          ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
        });

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
        return this.memory.remember(householdId, userId, str('text'));

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
    return this.proposals.createWeekPlanProposal({
      userId: context.userId,
      householdId: context.householdId,
      conversationId: context.conversationId,
      turnId: context.turnId,
      weekStart,
      slots: this.toSlots(input.slots, context) as unknown as ApplyWeekSlotDto[],
      ...(note ? { note } : {}),
    });
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

    const periodKey = this.counters.monthKey();
    const limit = readAgentEnv().plansPerMonth;
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
        `Limit zapisanych planów na ten miesiąc (${limit}) został wyczerpany. ` +
          'Możesz jeszcze zaproponować plan i pokazać go w odpowiedzi, ale nie zapiszesz go do końca miesiąca.',
        HttpStatus.TOO_MANY_REQUESTS,
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
      return {
        dayOfWeek: slot.day_of_week,
        mealType: slot.meal_type,
        recipeId: this.resolveRecipeRef(asString(slot.recipe), context),
        ...(Array.isArray(slot.participant_user_ids)
          ? { participantIds: slot.participant_user_ids }
          : {}),
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
