import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/app-exception';
import { mapError } from '../../common/error-contract';
import { HouseholdsService } from '../../households/households.service';
import { IngredientsService } from '../../recipes/ingredients.service';
import { RecipesService } from '../../recipes/recipes.service';
import { ApplyWeekPlanDto } from '../../weekly-plans/dto/apply-week-plan.dto';
import { WeeklyPlansService } from '../../weekly-plans/weekly-plans.service';
import { CreateRecipeDto } from '../../recipes/dto/create-recipe.dto';
import { UpdateRecipeDto } from '../../recipes/dto/update-recipe.dto';
import { AGENT_TOOL_NAMES } from './agent-tools';

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

      case 'apply_week_plan': {
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
        const payload: unknown = {
          dryRun: input.dry_run === true,
          slots: this.toSlots(input.slots, context),
        };
        return this.weeklyPlans.applyWeekPlan(
          userId,
          householdId,
          str('week_start'),
          payload as ApplyWeekPlanDto,
        );
      }

      case 'create_recipe': {
        const payload: unknown = {
          householdId,
          title: str('title'),
          ...(input.description ? { description: str('description') } : {}),
          mealType: str('meal_type'),
          difficulty: 'EASY',
          prepTimeMinutes: Number(input.prep_time_minutes ?? 0),
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

      case 'delete_recipe':
        return this.recipes.remove(userId, str('recipe_id'), householdId);

      default:
        return Promise.resolve(null);
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
