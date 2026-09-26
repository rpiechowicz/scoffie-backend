import { HttpStatus, Injectable } from '@nestjs/common';
import { DayOfWeek, DietPreferenceValue, MealType } from '@prisma/client';
import { AppException } from '../../common/app-exception';
import { readAgentEnv } from '../../config/agent-env';
import { normalizeText } from '../../common/normalize-text.util';
import { HouseholdsService } from '../../households/households.service';
import { MemberContext } from '../../households/member-context.util';
import {
  evaluatePlan,
  planMeals,
  SlotSuggestions,
  suggestForSlot,
} from '../../meal-planner/meal-plan-engine';
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
  PlanningScope,
} from '../../meal-planner/meal-planner.types';
import { PrismaService } from '../../prisma/prisma.service';
import { ApplyWeekSlotDto } from '../../weekly-plans/dto/apply-week-plan.dto';
import { autoPlannedServings } from '../../weekly-plans/utils/planned-servings.util';
import { WeeklyPlansService } from '../../weekly-plans/weekly-plans.service';
import { AgentPromptService } from '../agent-prompt.service';
import { AgentCatalogService } from '../search/agent-catalog.service';
import { ingredientMatches, SearchableRecipe } from '../search/catalog-search';
import { memoized, TURN_KEYS, TurnMemo } from '../turn-memo';

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
  /** Pamięć tury — domownicy i pory z tej samej tury, co prompt. */
  memo?: TurnMemo;
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
  memo?: TurnMemo;
};

/** Kilka dań na jeden slot (`suggest_meals`) — nic nie zapisuje. */
export type SuggestInput = {
  userId: string;
  householdId: string;
  weekStart: string;
  dayOfWeek: DayOfWeek;
  mealType: MealType;
  /** Puste = cały dom. */
  forUserIds: string[];
  wishes: PlannerWishes;
  /** Składniki, które MUSZĄ być w daniu („mam dużo kurczaka"). */
  includeIngredients: string[];
  count: number;
  seed: string;
  memo?: TurnMemo;
};

/**
 * Konkretne danie WYBRANE przez użytkownika („Wybieram drugą") do jednego
 * slotu — serwer sprawdza je filtrami twardymi i dobiera porcje, nie szuka
 * innego (review Etapu 3: model nie liczy ani nie przenosi porcji).
 */
export type ChoiceInput = {
  userId: string;
  householdId: string;
  weekStart: string;
  dayOfWeek: DayOfWeek;
  mealType: MealType;
  recipeId: string;
  /** Kto je nowe danie; [] = cały dom (podmiana całego slotu). */
  participantIds: string[];
  /** Stan docelowy tygodnia, w który wchodzi danie (plan albo propozycja). */
  currentSlots: ApplyWeekSlotDto[];
  seed: string;
  memo?: TurnMemo;
};

export type ChoiceOutcome =
  | { ok: true; portions?: { userId: string; servings: number }[] }
  | { ok: false; problem: string };

export type SuggestOutcome = {
  draft: SlotSuggestions;
  consentedUserIds: ReadonlySet<string>;
  titles: ReadonlyMap<string, string>;
  /** Kcal na porcję — do powodu „dlaczego to" bez drugiego odczytu. */
  recipes: ReadonlyMap<string, PlannerRecipe>;
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
    const members = await this.members(input);
    assertMembers(input.forUserIds, members);
    const enabled = await this.enabledMealTypes(input);
    const mealTypes =
      input.mealTypes.length > 0 ? [...new Set(input.mealTypes)] : enabled;
    const scope = scopeOf(mealTypes, enabled);
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
      scope,
      dayMealTypes: enabled,
      members: eaters,
      participantIds,
      fixed: kept.map((slot) => toItem(slot, eaters.length)),
      constraints: constraintsOf(input.wishes, []),
      preferences: { ...context.preferences, ...softOf(input.wishes) },
      // Porcje per osoba (Etap 2.2) za włącznikiem rolloutu.
      portionMode: readAgentEnv().plannerPerUserPortions ? 'per_user' : 'tune',
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
    const members = await this.members(input);
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
    const enabled = await this.enabledMealTypes(input);
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
      // Podmiana to zawsze CZĘŚĆ dnia: reszta dnia osoby zostaje i odejmuje
      // się od jej celu (tylko to, co ona rzeczywiście je).
      scope: 'PARTIAL',
      dayMealTypes: enabled,
      members: eaters,
      participantIds,
      fixed: kept.map((slot) => toItem(slot, eaters.length)),
      constraints: constraintsOf(
        input.wishes,
        replaced.map((slot) => slot.recipeId),
      ),
      preferences: { ...context.preferences, ...softOf(input.wishes) },
      slotKcalTargets,
      portionMode: readAgentEnv().plannerPerUserPortions
        ? 'per_user'
        : input.portionMode,
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
    const members = await this.members(input);
    const eaters = members.map(toEater);
    const context = await this.context(input, members, input.slots);
    const enabled = await this.enabledMealTypes(input);
    const mealTypes = input.mealTypes.length > 0 ? input.mealTypes : enabled;
    const request: PlanningRequest = {
      days: input.days,
      mealTypes,
      scope: scopeOf(mealTypes, enabled),
      dayMealTypes: enabled,
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

  /**
   * Kilka zróżnicowanych dań na jeden slot (`suggest_meals`): filtry twarde
   * wszystkich jedzących, życzenia z prośby, bilans osoby przy reszcie dnia
   * z planu. Obecne danie tego slotu wypada z propozycji — pytanie „co na
   * kolację?" przy zaplanowanej kolacji to pytanie o coś innego.
   */
  async suggest(input: SuggestInput): Promise<SuggestOutcome> {
    const members = await this.members(input);
    assertMembers(input.forUserIds, members);
    const eaters = members.map(toEater);
    const participantIds = normalizeParticipants(input.forUserIds, eaters);
    const audience = new Set(participantIds);
    const [enabled, baseline] = await Promise.all([
      this.enabledMealTypes(input),
      this.weeklyPlans.snapshotWeekAsSlots(
        input.userId,
        input.householdId,
        input.weekStart,
      ),
    ]);
    // To, co w tym slocie je (wyłącznie) audytorium — jak w `build`.
    const inSlot = (slot: ApplyWeekSlotDto) =>
      slot.dayOfWeek === input.dayOfWeek &&
      slot.mealType === input.mealType &&
      (participantIds.length === 0 ||
        ((slot.participantIds ?? []).length > 0 &&
          (slot.participantIds ?? []).every((id) => audience.has(id))));
    const current = baseline.filter(inSlot);
    const kept = baseline.filter((slot) => !inSlot(slot));
    const context = await this.context(input, members, kept);
    const wanted = input.includeIngredients
      .map((name) => name.trim())
      .filter(Boolean);
    const allowed =
      wanted.length > 0
        ? new Set(
            context.pool
              .filter((recipe) =>
                wanted.every((name) =>
                  recipe.ingredients.some((ingredient) =>
                    ingredientMatches(ingredient.name, name),
                  ),
                ),
              )
              .map((recipe) => recipe.id),
          )
        : undefined;
    const request: PlanningRequest = {
      days: [input.dayOfWeek],
      mealTypes: [input.mealType],
      scope: 'PARTIAL',
      dayMealTypes: enabled,
      members: eaters,
      participantIds,
      fixed: kept.map((slot) => toItem(slot, eaters.length)),
      constraints: constraintsOf(
        input.wishes,
        current.map((slot) => slot.recipeId),
      ),
      preferences: { ...context.preferences, ...softOf(input.wishes) },
      // Porcje per osoba (Etap 2.2) za tym samym włącznikiem, co build/replace:
      // przy włączonym danie ocenia się z porcją KAŻDEJ osoby, a wybór z karty
      // dostaje potem te porcje od serwera (`portionsForChoice`).
      portionMode: readAgentEnv().plannerPerUserPortions ? 'per_user' : 'auto',
      seed: input.seed,
    };
    return {
      draft: suggestForSlot(request, context.recipes, {
        count: input.count,
        ...(allowed ? { allowedRecipeIds: allowed } : {}),
      }),
      consentedUserIds: context.consented,
      titles: context.titles,
      recipes: context.lookup,
    };
  }

  /**
   * Porcje per osoba dla dania WYBRANEGO przez użytkownika (review Etapu 3).
   *
   * Ten sam planer, zawężony do jednego przepisu (`onlyRecipeIds`): filtry
   * twarde wszystkich jedzących (alergeny, wykluczenia, DIETA), bilans osoby
   * przy reszcie dnia, porcja 0,5–1,5 co 0,05. Danie, które nie przechodzi
   * filtrów, wraca jako `problem` — nie jako cicha podmiana na inne.
   */
  async portionsForChoice(input: ChoiceInput): Promise<ChoiceOutcome> {
    const members = await this.members(input);
    assertMembers(input.participantIds, members);
    const eaters = members.map(toEater);
    const participantIds = normalizeParticipants(input.participantIds, eaters);
    const audience = new Set(participantIds);
    // Z tego slotu znika to, co je (wyłącznie) audytorium nowego dania —
    // jak w `build` i `suggest`; pozycje innych osób zostają.
    const inSlot = (slot: ApplyWeekSlotDto) =>
      slot.dayOfWeek === input.dayOfWeek &&
      slot.mealType === input.mealType &&
      (participantIds.length === 0 ||
        ((slot.participantIds ?? []).length > 0 &&
          (slot.participantIds ?? []).every((id) => audience.has(id))));
    const kept = input.currentSlots.filter((slot) => !inSlot(slot));
    const [enabled, context] = await Promise.all([
      this.enabledMealTypes(input),
      this.context(input, members, kept),
    ]);
    const request: PlanningRequest = {
      days: [input.dayOfWeek],
      mealTypes: [input.mealType],
      scope: 'PARTIAL',
      dayMealTypes: enabled,
      members: eaters,
      participantIds,
      fixed: kept.map((slot) => toItem(slot, eaters.length)),
      constraints: constraintsOf(NO_WISHES, []),
      preferences: { ...context.preferences, ...softOf(NO_WISHES) },
      portionMode: 'per_user',
      onlyRecipeIds: [input.recipeId],
      seed: input.seed,
    };
    const draft = planMeals(request, context.recipes);
    const [item] = draft.items;
    if (!item) {
      const reason = draft.diagnostics.issues.find(
        (issue) => issue.code === 'NO_CANDIDATES',
      );
      return {
        ok: false,
        problem:
          reason?.message ??
          'To danie nie pasuje do tego posiłku albo do ograniczeń jedzących.',
      };
    }
    return item.portions?.length
      ? { ok: true, portions: item.portions }
      : { ok: true };
  }

  /** Domownicy z celami — raz na turę (`TurnMemo`). */
  private members(input: {
    userId: string;
    householdId: string;
    memo?: TurnMemo;
  }): Promise<MemberContext[]> {
    return memoized(
      input.memo,
      TURN_KEYS.members(input.userId, input.householdId),
      () => this.households.memberPreferences(input.userId, input.householdId),
    );
  }

  private async context(
    input: {
      userId: string;
      householdId: string;
      weekStart: string;
      memo?: TurnMemo;
    },
    members: MemberContext[],
    slotsInPlay: readonly ApplyWeekSlotDto[],
  ) {
    const [{ recipes: pool, signals }, { members: consented }] =
      await Promise.all([
        this.catalog.planningPool({
          householdId: input.householdId,
          weekStart: input.weekStart,
        }),
        memoized(
          input.memo,
          TURN_KEYS.visible(input.userId, input.householdId),
          () => this.prompts.membersForModel(members),
        ),
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
      pool,
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

  private async enabledMealTypes(input: {
    householdId: string;
    memo?: TurnMemo;
  }): Promise<MealType[]> {
    // Ten sam wiersz i ten sam klucz, co prompt tury (`TURN_KEYS.household`).
    const household = await memoized(
      input.memo,
      TURN_KEYS.household(input.householdId),
      () =>
        this.prisma.household.findUnique({
          where: { id: input.householdId },
          select: { name: true, enabledMealTypes: true },
        }),
    );
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
    // `FULL_DAY`: kcal osób = cały dzień wobec pełnego celu; `PARTIAL`: tylko
    // planowane pory wobec ich części pozostałego celu dnia.
    scope: draft.diagnostics.days[0]?.scope ?? null,
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

/**
 * Zakres planu z kontraktu `build_meal_plan`: puste `meal_types` = pory domu
 * (`enabledMealTypes`) = pełny dzień; jawny wybór obejmujący wszystkie pory
 * domu — też pełny dzień; podzbiór — część dnia. Aplikacja porównuje dzień
 * z PEŁNYM celem (`WeeklyPlanView` × `DailyNutritionTargets`), a pory domu
 * są jej obowiązkowymi slotami — stąd pełny dzień = 100 % celu.
 */
function scopeOf(
  mealTypes: readonly MealType[],
  enabled: readonly MealType[],
): PlanningScope {
  return enabled.every((meal) => mealTypes.includes(meal))
    ? 'FULL_DAY'
    : 'PARTIAL';
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

/** Bez życzeń z prośby — wybór konkretnego dania ich nie niesie. */
const NO_WISHES: PlannerWishes = {
  diet: null,
  requiredTags: [],
  preferredTags: [],
  avoidIngredients: [],
  maxPrepMinutes: null,
};

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
    // Porcje per osoba nietkniętych pozycji jadą dalej bez zmian (Etap 2.2).
    ...(slot.portions?.length ? { portions: slot.portions } : {}),
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
    ...(item.portions?.length
      ? { portions: item.portions }
      : { plannedServings: item.plannedServings }),
  } as ApplyWeekSlotDto;
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
