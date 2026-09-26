import { HttpStatus, Injectable } from '@nestjs/common';
import { DayOfWeek, DietPreferenceValue, MealType } from '@prisma/client';
import { AppException } from '../../common/app-exception';
import { normalizeText } from '../../common/normalize-text.util';
import { HouseholdsService } from '../../households/households.service';
import { MemberContext } from '../../households/member-context.util';
import { evaluatePlan, planMeals } from '../../meal-planner/meal-plan-engine';
import {
  eaterDayNutrition,
  normalizeParticipants,
} from '../../meal-planner/meal-plan-scoring';
import {
  PlanDraft,
  PlannedItem,
  PlannerEater,
  PlannerRecipe,
  PlanningRequest,
} from '../../meal-planner/meal-planner.types';
import { PrismaService } from '../../prisma/prisma.service';
import { ApplyWeekSlotDto } from '../../weekly-plans/dto/apply-week-plan.dto';
import { autoPlannedServings } from '../../weekly-plans/utils/planned-servings.util';
import { WeeklyPlansService } from '../../weekly-plans/weekly-plans.service';
import { AgentPromptService } from '../agent-prompt.service';
import { AgentCatalogService } from '../search/agent-catalog.service';
import { SearchableRecipe } from '../search/catalog-search';

/** Miękkie i twarde życzenia z prośby — to, co model wyczytał ze zdania. */
export type PlannerWishes = {
  /** Dieta dla TEJ prośby (twarda); `null` = bez dodatkowej. */
  diet: DietPreferenceValue | null;
  /** Tagi, które danie musi mieć (twarde). */
  requiredTags: string[];
  /** Tagi mile widziane (miękkie). */
  preferredTags: string[];
  /** Składniki, których ma nie być (twarde; nazwy po polsku). */
  avoidIngredients: string[];
  /** Podpowiedź czasu gotowania (miękka); `null` = bez. */
  maxPrepMinutes: number | null;
};

export type BuildPlanInput = {
  userId: string;
  householdId: string;
  weekStart: string;
  days: DayOfWeek[];
  /** Puste = pory włączone w domu. */
  mealTypes: MealType[];
  /** Puste = cały dom. */
  forUserIds: string[];
  wishes: PlannerWishes;
  seed: string;
};

export type ReplaceSlotInput = {
  userId: string;
  householdId: string;
  weekStart: string;
  dayOfWeek: DayOfWeek;
  mealType: MealType;
  /** Stan docelowy tygodnia, w którym podmieniamy (plan albo propozycja). */
  currentSlots: ApplyWeekSlotDto[];
  wishes: PlannerWishes;
  /** Kcal na osobę blisko zastępowanego dania. */
  similarKcal: boolean;
  /** `auto` tam, gdzie ścieżka zapisu i tak liczy porcje z audytorium. */
  portionMode: 'auto' | 'tune';
  seed: string;
};

export type PlannerOutcome = {
  draft: PlanDraft;
  /** Stan docelowy tygodnia: to, co zostaje, + nowe pozycje. */
  targetSlots: ApplyWeekSlotDto[];
  /** Domownicy, o których model może się dowiedzieć (zgoda). */
  consentedUserIds: ReadonlySet<string>;
  titles: ReadonlyMap<string, string>;
};

/**
 * Adapter serwerowego planera dla asystenta (workstream, Etap 2E).
 *
 * Silnik (`src/meal-planner/`) jest czysty; tutaj dzieje się to, co wymaga
 * bazy i tożsamości: członkostwo (przez `memberPreferences`), profile i cele
 * WSZYSTKICH domowników (także bez zgody — ich alergeny i dieta obowiązują,
 * tylko model nie dostaje o nich szczegółów), pula przepisów widocznych dla
 * domu (katalog z pamięci + własne), sygnały rankingu i to, co już stoi
 * w tygodniu. Zapis NIE dzieje się tutaj — wynik idzie przez propozycję
 * (`AgentProposalsService`) i kliknięcie człowieka.
 */
@Injectable()
export class AgentMealPlannerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: AgentCatalogService,
    private readonly households: HouseholdsService,
    private readonly weeklyPlans: WeeklyPlansService,
    private readonly prompts: AgentPromptService,
  ) {}

  /** Plan dni × pór od zera (to, co w tych slotach stoi, zostaje zastąpione). */
  async build(input: BuildPlanInput): Promise<PlannerOutcome> {
    const members = await this.households.memberPreferences(
      input.userId,
      input.householdId,
    );
    assertMembers(input.forUserIds, members);
    const mealTypes =
      input.mealTypes.length > 0
        ? [...new Set(input.mealTypes)]
        : await this.enabledMealTypes(input.householdId);
    const baseline = await this.weeklyPlans.snapshotWeekAsSlots(
      input.userId,
      input.householdId,
      input.weekStart,
    );
    const eaters = members.map(toEater);
    const participantIds = normalizeParticipants(input.forUserIds, eaters);
    const days = new Set(input.days);
    const meals = new Set(mealTypes);
    const audience = new Set(participantIds);
    // Zastępujemy w planowanych slotach to, co je WYŁĄCZNIE audytorium:
    // przy całym domu — wszystko; przy części domu — dania imienne tych osób
    // (wspólne zostaje dla reszty, a własne danie i tak wygrywa ze wspólnym).
    const replaced = (slot: ApplyWeekSlotDto) =>
      days.has(slot.dayOfWeek) &&
      meals.has(slot.mealType) &&
      (participantIds.length === 0 ||
        ((slot.participantIds ?? []).length > 0 &&
          (slot.participantIds ?? []).every((id) => audience.has(id))));
    const kept = baseline.filter((slot) => !replaced(slot));

    const context = await this.context(input, members, kept);
    const request: PlanningRequest = {
      days: [...days],
      mealTypes,
      members: eaters,
      participantIds,
      fixed: kept.map((slot) => toItem(slot, eaters.length)),
      constraints: constraintsOf(input.wishes, []),
      preferences: { ...context.preferences, ...softOf(input.wishes) },
      portionMode: 'tune',
      seed: input.seed,
    };
    const draft = planMeals(request, context.recipes);
    return {
      draft,
      targetSlots: [...kept, ...draft.items.map(toSlot)],
      consentedUserIds: context.consented,
      titles: context.titles,
    };
  }

  /**
   * Nowe danie w JEDNYM slocie; reszta `currentSlots` zostaje nietknięta.
   * Slot podmieniamy w całości (jak `propose_swap` i `revise_proposal`):
   * uczestnicy nowego dania to suma dotychczasowych, a gdy którakolwiek
   * pozycja była dla całego domu — cały dom.
   */
  async replace(input: ReplaceSlotInput): Promise<PlannerOutcome> {
    const members = await this.households.memberPreferences(
      input.userId,
      input.householdId,
    );
    const eaters = members.map(toEater);
    const inSlot = (slot: ApplyWeekSlotDto) =>
      slot.dayOfWeek === input.dayOfWeek && slot.mealType === input.mealType;
    const replaced = input.currentSlots.filter(inSlot);
    const kept = input.currentSlots.filter((slot) => !inSlot(slot));
    const participantIds =
      replaced.length === 0 ||
      replaced.some((slot) => !(slot.participantIds ?? []).length)
        ? []
        : normalizeParticipants(
            replaced.flatMap((slot) => slot.participantIds ?? []),
            eaters,
          );

    const context = await this.context(input, members, input.currentSlots);
    const slotKcalTargets: Record<string, number> = {};
    if (input.similarKcal && replaced.length > 0) {
      const perPerson = averagePersonKcal(
        replaced.map((slot) => toItem(slot, eaters.length)),
        participantIds,
        eaters,
        context.lookup,
      );
      if (perPerson > 0) {
        slotKcalTargets[`${input.dayOfWeek}|${input.mealType}`] = perPerson;
      }
    }
    const request: PlanningRequest = {
      days: [input.dayOfWeek],
      mealTypes: [input.mealType],
      members: eaters,
      participantIds,
      fixed: kept.map((slot) => toItem(slot, eaters.length)),
      constraints: constraintsOf(
        input.wishes,
        replaced.map((slot) => slot.recipeId),
      ),
      preferences: { ...context.preferences, ...softOf(input.wishes) },
      slotKcalTargets,
      portionMode: input.portionMode,
      seed: input.seed,
    };
    const draft = planMeals(request, context.recipes);
    return {
      draft,
      targetSlots: [...kept, ...draft.items.map(toSlot)],
      consentedUserIds: context.consented,
      titles: context.titles,
    };
  }

  /** Ocena dowolnego stanu docelowego tymi samymi metrykami (np. planu modelu). */
  async evaluate(
    input: Omit<BuildPlanInput, 'wishes' | 'seed'> & {
      slots: ApplyWeekSlotDto[];
    },
  ) {
    const members = await this.households.memberPreferences(
      input.userId,
      input.householdId,
    );
    const eaters = members.map(toEater);
    const context = await this.context(input, members, input.slots);
    const mealTypes =
      input.mealTypes.length > 0
        ? input.mealTypes
        : await this.enabledMealTypes(input.householdId);
    const request: PlanningRequest = {
      days: input.days,
      mealTypes,
      members: eaters,
      participantIds: normalizeParticipants(input.forUserIds, eaters),
      fixed: [],
      constraints: constraintsOf(
        {
          diet: null,
          requiredTags: [],
          preferredTags: [],
          avoidIngredients: [],
          maxPrepMinutes: null,
        },
        [],
      ),
      preferences: {
        ...context.preferences,
        preferredTags: [],
        maxPrepMinutes: null,
      },
    };
    return evaluatePlan(
      request,
      context.recipes,
      input.slots.map((slot) => toItem(slot, eaters.length)),
    );
  }

  private async context(
    input: { householdId: string; weekStart: string },
    members: MemberContext[],
    slotsInPlay: readonly ApplyWeekSlotDto[],
  ) {
    const [{ recipes: pool, signals }, { members: consented }] =
      await Promise.all([
        this.catalog.planningPool({
          householdId: input.householdId,
          weekStart: input.weekStart,
        }),
        this.prompts.membersForModel(members),
      ]);
    const known = new Set(pool.map((recipe) => recipe.id));
    const missing = slotsInPlay
      .map((slot) => slot.recipeId)
      .filter((id) => !known.has(id));
    // Pozycje planu z przepisami spoza puli (wycofane) — tylko do bilansu.
    const extra = await this.catalog.searchablesByIds(
      input.householdId,
      missing,
    );
    const recipes = [
      ...pool.map((recipe) => toPlannerRecipe(recipe, true)),
      ...extra.map((recipe) => toPlannerRecipe(recipe, false)),
    ];
    return {
      recipes,
      lookup: new Map(recipes.map((recipe) => [recipe.id, recipe])),
      titles: new Map(recipes.map((recipe) => [recipe.id, recipe.title])),
      consented: new Set(consented.map((member) => member.userId)),
      preferences: {
        favoriteRecipeIds: [...signals.favorites],
        recentRecipeIds: [...signals.plannedLastWeek],
        popularity: Object.fromEntries(signals.popularity),
      },
    };
  }

  private async enabledMealTypes(householdId: string): Promise<MealType[]> {
    const household = await this.prisma.household.findUnique({
      where: { id: householdId },
      select: { enabledMealTypes: true },
    });
    const enabled = household?.enabledMealTypes ?? [];
    return enabled.length > 0 ? enabled : ['BREAKFAST', 'LUNCH', 'DINNER'];
  }
}

/**
 * Wynik planera dla MODELU — zwięźle i z filtrem zgód: bilans i powody
 * dotyczące domownika bez zgody na asystenta idą bez liczb i bez
 * identyfikatora (jego ograniczenia planer i tak stosuje).
 */
export function plannerResultForModel(outcome: PlannerOutcome) {
  const { draft, consentedUserIds } = outcome;
  const metrics = draft.diagnostics.metrics;
  const visible = (userId?: string) =>
    userId === undefined || consentedUserIds.has(userId);
  const issues = draft.diagnostics.issues
    .filter(
      (issue) => issue.severity !== 'info' || issue.code === 'REPEAT_FORCED',
    )
    .map((issue) => {
      const where = [issue.dayOfWeek, issue.mealType].filter(Boolean).join(' ');
      const body = visible(issue.userId)
        ? `${issue.userId ? `${issue.userId}: ` : ''}${issue.message}`
        : 'domownik bez zgody na asystenta: cel dnia nietrafiony (bez szczegółów)';
      return `${issue.code}${where ? ` ${where}` : ''} — ${body}`;
    })
    .slice(0, 10);
  const perPerson = new Map<
    string,
    { kcal: number; target: number; n: number }
  >();
  for (const day of draft.diagnostics.days) {
    for (const eater of day.eaters) {
      if (!consentedUserIds.has(eater.userId)) continue;
      const entry = perPerson.get(eater.userId) ?? { kcal: 0, target: 0, n: 0 };
      entry.kcal += eater.kcal;
      entry.target += eater.kcalTarget;
      entry.n += 1;
      perPerson.set(eater.userId, entry);
    }
  }
  return {
    status: draft.status,
    filled: `${metrics.slotsFilled}/${metrics.slotsRequested}`,
    kcalDeviationPct: metrics.kcalDeviationPct,
    proteinDeviationPct: metrics.proteinDeviationPct,
    repeats: metrics.repeats,
    perPersonDaily: [...perPerson.entries()].map(([userId, entry]) => ({
      userId,
      avgKcal: Math.round(entry.kcal / entry.n),
      avgTargetKcal: Math.round(entry.target / entry.n),
    })),
    issues,
  };
}

function assertMembers(
  forUserIds: readonly string[],
  members: MemberContext[],
) {
  const known = new Set(members.map((member) => member.userId));
  const unknown = forUserIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new AppException(
      'VALIDATION_ERROR',
      'for_user_ids: to nie są domownicy tego gospodarstwa. Zostaw listę pustą (cały dom) albo weź identyfikatory z kontekstu.',
      HttpStatus.BAD_REQUEST,
      unknown,
    );
  }
}

function toEater(member: MemberContext): PlannerEater {
  return {
    userId: member.userId,
    allergens: member.allergens,
    excludedIngredientIds: member.restrictions.excludedIngredients.map(
      (ingredient) => ingredient.id,
    ),
    diet: member.dietPreference,
    kcalTarget: member.targets.calorieGoal,
    macros: member.targets.macros,
  };
}

function toPlannerRecipe(
  recipe: SearchableRecipe,
  active: boolean,
): PlannerRecipe {
  return {
    id: recipe.id,
    title: recipe.title,
    slots: recipe.slots,
    servings: recipe.servings,
    prepTimeMinutes: recipe.prepTimeMinutes,
    perServing: recipe.perServing,
    allergens: recipe.allergens,
    dietTags: recipe.dietTags,
    ingredientIds: recipe.ingredients.map((ingredient) => ingredient.id),
    ingredientNames: recipe.ingredients.map((ingredient) =>
      normalizeText(ingredient.name),
    ),
    sharedIngredientIds: recipe.ingredients
      .filter((ingredient) => !ingredient.pantry)
      .map((ingredient) => ingredient.id),
    tags: recipe.tags,
    active,
  };
}

function constraintsOf(wishes: PlannerWishes, excludeRecipeIds: string[]) {
  return {
    diet: wishes.diet && wishes.diet !== 'NONE' ? wishes.diet : null,
    requiredTags: wishes.requiredTags,
    avoidIngredients: wishes.avoidIngredients
      .map((name) => normalizeText(name).trim())
      .filter(Boolean),
    excludeRecipeIds,
  };
}

function softOf(wishes: PlannerWishes) {
  return {
    preferredTags: wishes.preferredTags,
    maxPrepMinutes: wishes.maxPrepMinutes,
  };
}

function toItem(slot: ApplyWeekSlotDto, memberCount: number): PlannedItem {
  const participantIds = slot.participantIds ?? [];
  return {
    dayOfWeek: slot.dayOfWeek,
    mealType: slot.mealType,
    recipeId: slot.recipeId,
    participantIds,
    plannedServings:
      slot.plannedServings ??
      autoPlannedServings(participantIds.length, memberCount),
  };
}

function toSlot(item: PlannedItem): ApplyWeekSlotDto {
  return {
    dayOfWeek: item.dayOfWeek,
    mealType: item.mealType,
    recipeId: item.recipeId,
    ...(item.participantIds.length > 0
      ? { participantIds: item.participantIds }
      : {}),
    plannedServings: item.plannedServings,
  };
}

/** Średnie kcal NA OSOBĘ z podmienianych pozycji — dla „podobnie kalorycznie". */
function averagePersonKcal(
  items: PlannedItem[],
  participantIds: string[],
  eaters: PlannerEater[],
  lookup: ReadonlyMap<string, PlannerRecipe>,
): number {
  const audience =
    participantIds.length > 0
      ? eaters.filter((eater) => participantIds.includes(eater.userId))
      : eaters;
  if (audience.length === 0) return 0;
  const total = audience.reduce(
    (sum, eater) =>
      sum + eaterDayNutrition(items, eater.userId, eaters.length, lookup).kcal,
    0,
  );
  return total / audience.length;
}
