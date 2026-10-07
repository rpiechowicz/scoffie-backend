import {
  derivedPlannedServings,
  PortionView,
  portionsProblem,
  PORTIONS_CONFLICT_MESSAGE,
  planPortionsForExisting,
  portionIntentOf,
  type PortionPolicy,
  portionsRemovalDecision,
  portionsWriteDecision,
  PRESERVE_SERVINGS_PROBLEM,
  remapPortions,
  type PortionsWritePolicy,
  REVISION_CONFLICT_MESSAGE,
  REVISION_REQUIRED_MESSAGE,
  samePortions,
  servingsToUnits,
  toPortionRows,
  toPortionViews,
} from './utils/plan-portions.util';
import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { assertUuid, isUuid } from '../common/uuid';
import { validateDto } from '../common/validate-dto';
import { emitLive } from '../common/live-events';
import { PrismaService } from '../prisma/prisma.service';
import { ApplyWeekPlanDto, ApplyWeekSlotDto } from './dto/apply-week-plan.dto';
import { UpsertWeekSlotDto } from './dto/upsert-week-slot.dto';
import { RemoveWeekSlotDto } from './dto/remove-week-slot.dto';
import { SetMealEatenDto } from './dto/set-meal-eaten.dto';
import { LogCookedMealDto } from './dto/log-cooked-meal.dto';
import { SetPortionDto } from './dto/set-portion.dto';
import {
  DayOfWeek,
  DietPreferenceValue,
  MealType,
  Prisma,
} from '@prisma/client';
import { AppErrorCode } from '../common/app-error-code';
import {
  MEAL_TYPES_IN_DAY_ORDER,
  effectiveSuitableMealTypes,
} from '../common/meal-types';
import {
  allergenConflicts,
  excludedIngredientHits,
  subjectSatisfiesDiet,
} from '../recipes/constraints/recipe-constraints';
import {
  nutritionPerServing,
  type NutritionPerServing,
} from '../recipes/diet-rules.util';
import { formatWeekStart, parseWeekStart } from './utils/week-formatting.util';
import {
  autoPlannedServings,
  clampPlannedServings,
} from './utils/planned-servings.util';
import {
  ensureMembership,
  ensureMembershipInTx,
  ensureRecipeForHousehold,
} from './utils/auth-checks.util';
import { runSerializable } from './utils/transaction-runner.util';
import {
  bumpWeekRevision,
  lockWeekForWrite,
} from './utils/week-write-lock.util';
import {
  servingsPerPerson,
  visibleToMember,
  weeklyBalanceForMember,
} from './utils/daily-balance.util';
import { ShoppingListService } from './services/shopping-list.service';
import { isGeneratedRecipeImageUrl } from '../recipes/recipe-image-generator';

/**
 * Everything a PlanItem read needs: the recipe payload the app renders, plus
 * the participant ids that say who the meal is for (empty = everyone).
 */
const PLAN_ITEM_INCLUDE = {
  recipe: {
    select: {
      id: true,
      title: true,
      description: true,
      mealType: true,
      difficulty: true,
      prepTimeMinutes: true,
      servings: true,
      imageUrl: true,
      nutritionKcal: true,
      nutritionProtein: true,
      nutritionFat: true,
      nutritionCarbs: true,
      nutritionFiber: true,
      nutritionSalt: true,
      isActive: true,
      authorId: true,
      householdId: true,
      ingredients: true,
      // Te trzy pola tak samo jak w `recipes:findAll`: klient (i asystent)
      // filtrują po alergenach i dietach także w planie, a slot bazowy +
      // `suitableMealTypes` mówi, gdzie danie wolno przenieść (bez nich iOS
      // wracał do heurystyki po nazwach). Reszta kształtu NIE jest jeszcze
      // tożsama z listą: `imageUrl` jedzie surowo (bez `resolveRecipeImageUrl`),
      // brak `sourceProvider`/`sourceRecipeId`/`isFavorite`, `ingredients` to
      // pełne wiersze — szczegół i tak otwiera się przez `recipes:findById`.
      allergens: true,
      dietTags: true,
      suitableMealTypes: true,
    },
  },
  participants: { select: { userId: true } },
  consumptions: { select: { userId: true } },
  portions: { select: { userId: true, units: true, revision: true } },
} satisfies Prisma.PlanItemInclude;

/**
 * Diety, których pilnuje zapis planu asystenta: tylko SKŁADNIKOWE (mięso,
 * ryba, nabiał…). KETO i HIGH_PROTEIN to cele makro — planer je optymalizuje,
 * ale w zapisie byłyby wetem dla całego domu (przepis bez makr, owsianka
 * z mało białka), a ogólny komunikat nie pozwala modelowi wyjaśnić odmowy.
 */
const WRITE_GATE_DIETS: ReadonlySet<DietPreferenceValue> = new Set([
  'VEGETARIAN',
  'VEGAN',
  'PESCATARIAN',
  'PALEO',
]);

/** Wiersz `PlanItem` dokładnie w kształcie `PLAN_ITEM_INCLUDE`. */
type PlanItemRow = Prisma.PlanItemGetPayload<{
  include: typeof PLAN_ITEM_INCLUDE;
}>;

/**
 * Czy dwa audytoria opisują ten sam zbiór osób. Kolejność i duplikaty nie
 * znaczą nic — `participantIds` przychodzi z klienta w kolejności klikania.
 */
function sameMemberSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  return b.every((id) => left.has(id));
}

/**
 * `replaceRecipeId` z DTO: `null`, gdy nie ma czego podmieniać.
 *
 * Równe `recipeId` też znaczy „bez podmiany" — `PlanSlotPickerSheet` wysyła
 * edytowany przepis zawsze, także gdy użytkownik ruszył tylko audytorium; bez
 * tej reguły każda taka edycja kasowałaby item, żeby zaraz założyć go na nowo
 * (i po drodze gubiła znaczniki zjedzenia).
 *
 * Format pilnuje już `@IsUUID()` w DTO (od Fazy 0 `validateDto` odpala go
 * także na WS); sprawdzenie niżej zostaje jako druga linia dla wywołań, które
 * ominęłyby DTO.
 */
function parseReplaceRecipeId(value: unknown, recipeId: string): string | null {
  if (value == null || value === '') return null;
  if (!isUuid(value)) {
    throw new AppException(
      'VALIDATION_ERROR',
      'replaceRecipeId musi być identyfikatorem UUID',
      HttpStatus.BAD_REQUEST,
    );
  }
  return value === recipeId ? null : value;
}

/**
 * Flattens the join rows into the flat id arrays the clients read (see
 * `PlanItemDto`). Without this the wire shape would leak the junction tables
 * as `participants: [{ userId }]` / `consumptions: [{ userId }]`.
 *
 * `suitableMealTypes` przechodzi przez `effectiveSuitableMealTypes` tak samo,
 * jak w `recipes.service.ts`: pusta lista z bazy (wiersze sprzed backfillu)
 * znaczy „tylko slot bazowy", a klient nie musi znać tej reguły.
 */
function withPlanItemRelationIds(item: PlanItemRow) {
  const { participants, consumptions, portions, recipe, ...rest } = item;
  return {
    ...rest,
    recipe: {
      ...recipe,
      suitableMealTypes: effectiveSuitableMealTypes(recipe),
    },
    participantIds: participants.map((p) => p.userId),
    eatenByUserIds: consumptions.map((c) => c.userId),
    // Porcje per osoba (Etap 2.2) w porcjach; pusta lista = równy podział.
    // `revision` porcji = token `setPortion` tej osoby; `revision` pozycji
    // (w `rest`) = token `upsertWeekSlot` (ADR `plan-portions-safe-editing`).
    portions: toPortionViews(portions).map((portion) => ({
      ...portion,
      revision:
        portions.find((row) => row.userId === portion.userId)?.revision ?? 0,
    })),
  };
}

/** Kolejność dni w odpowiedzi bilansu — ta sama, co w enumie schematu. */
const DAYS_IN_WEEK_ORDER: readonly DayOfWeek[] = [
  'MON',
  'TUE',
  'WED',
  'THU',
  'FRI',
  'SAT',
  'SUN',
];

/** Klucz tożsamości pozycji planu: dzień + posiłek + przepis. */
function planSlotKey(slot: {
  dayOfWeek: DayOfWeek;
  mealType: MealType;
  recipeId: string;
}): string {
  return `${slot.dayOfWeek}|${slot.mealType}|${slot.recipeId}`;
}

function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  return b.every((id) => left.has(id));
}

type PlannableRecipe = {
  id: string;
  mealType: MealType;
  suitableMealTypes: MealType[];
  allergens: string[];
  /** Identyfikatory składników — po nich sprawdzamy wykluczenia domowników. */
  ingredientIds: string[];
  /** `Recipe.dietTags` i makro porcji — reguły diet (`subjectSatisfiesDiet`). */
  dietTags: string[];
  perServing: NutritionPerServing | null;
};

/**
 * Dieta w walidatorze zapisu tygodnia (decyzja S5, 3.10.2026): planer
 * i wyszukiwarka diety pilnują, a zapis nie — model wybierający danie
 * w poprawce propozycji mógł wstawić mięso wegetarianinowi. Sprawdzamy TYLKO
 * osoby, które pozycja DOKŁADA do jedzących względem bazy (nowa pozycja =
 * wszyscy jej jedzący): ręcznie dodane danie spoza diety, którego asystent nie
 * rusza albo tylko zawęża, nie może zablokować mu zapisu tygodnia (ryzyko R3
 * z N8A). Ręczny zapis pozycji z telefonu (`upsertWeekSlot`) i cofnięcie
 * propozycji (`dietScope: 'none'`) diety nie sprawdzają.
 */
type DietGate = {
  dietByMember: Map<string, DietPreferenceValue>;
  /** Jedzący pozycji dziś w bazie: klucz `dzień|pora|przepis` → osoby. */
  current: Map<string, ReadonlySet<string>>;
  /** Raport (`check_plan_conflicts`): każda dieta, też makro — nic nie blokuje. */
  allDiets?: boolean;
};

/** Jeden powód, dla którego pozycja tygodnia nie może wejść. */
export type PlanViolation = {
  /**
   * Pozycja w przysłanej liście `slots` — wołający wie, co poprawić. `-1` =
   * pozycja SPOZA stanu docelowego, której zapis nie może usunąć (porcje per
   * osoba), albo cały tydzień (`PLAN_REVISION_CONFLICT` — wtedy bez
   * `dayOfWeek`/`mealType`/`recipeId`).
   */
  index: number;
  dayOfWeek?: DayOfWeek;
  mealType?: MealType;
  recipeId?: string;
  code: AppErrorCode;
  message: string;
};

/**
 * Haki WEWNĘTRZNE `applyWeekPlan` — dla wołających in-process (asystent),
 * nigdy z drutu: gateway ich nie przekazuje, a DTO ich nie zna.
 *
 * Oba biegną W TRANSAKCJI zapisu, po zamku tygodnia, i to jest cały ich sens:
 * warunek, od którego zależy zapis, oraz rozliczenie, które ma zapaść razem
 * z nim, nie mogą żyć po stronie wołającego — między jego sprawdzeniem
 * a naszym zapisem zmieściłby się cudzy zapis. Transakcja bywa ponawiana
 * (`runSerializable`), więc haki biegną w KAŻDEJ próbie od nowa i nie mogą
 * robić nic poza bazą przez przekazany `tx`. Rzut wycofuje całość.
 *
 * Domena nie wie, kto i po co je podaje — zależność zostaje jednokierunkowa.
 */
export type ApplyWeekPlanHooks = {
  /** Przed jakimkolwiek zapisem; `current` = tydzień odczytany pod zamkiem. */
  guard?: (
    tx: Prisma.TransactionClient,
    current: ApplyWeekSlotDto[],
  ) => Promise<void>;
  /** Po zapisie pozycji, przed zatwierdzeniem. */
  settle?: (
    tx: Prisma.TransactionClient,
    changes: { created: number; updated: number; deleted: number },
  ) => Promise<void>;
  /**
   * Jak zapis traktuje alokację, którą pozycja już ma (domyślnie `strict`) —
   * patrz `PortionsWritePolicy` i `docs/adr/plan-portions-write-safety.md`.
   * `verified` i `authoritative` wolno podać WYŁĄCZNIE razem z `guard`, który
   * w tej samej transakcji sprawdza odcisk tygodnia z porcjami (zapis
   * i cofnięcie propozycji). Z drutu `verified` powstaje tylko ze zgodnego
   * `expectedRevision` — polityka nie jest polem DTO.
   */
  portionsPolicy?: PortionsWritePolicy;
  /**
   * `none` — bez bramki diety. Tylko cofnięcie propozycji: przywraca dokładną
   * migawkę stanu, który legalnie był w bazie (danie spoza diety dodane
   * ręcznie). Wolno WYŁĄCZNIE z `guard` (odcisk tygodnia pod zamkiem).
   */
  dietScope?: 'changed' | 'none';
};

/** Jedna pozycja proponowanego tygodnia, gotowa do pokazania człowiekowi. */
export type WeekPlanPreviewSlot = {
  dayOfWeek: DayOfWeek;
  mealType: MealType;
  recipeId: string;
  title: string;
  /** Kalorie na porcję — kartę interesuje ta liczba, nie suma przepisu. */
  kcalPerServing: number;
  prepTimeMinutes: number;
  /**
   * Zdjęcie dania; `null`, gdy przepis go nie ma.
   *
   * Idzie surowo z bazy, bez generatora obrazów z `RecipesService`: karta
   * pokazuje miniaturę 40 px, a wygenerowany obrazek zastępczy kosztowałby
   * tam więcej niż daje. Brak zdjęcia klient rysuje sam.
   */
  imageUrl: string | null;
  /** Puste = całe gospodarstwo (ta sama konwencja co w `PlanItem`). */
  participantIds: string[];
  /** Porcje per osoba (Etap 2.2); brak = równy podział. */
  portions?: PortionView[];
  /**
   * Bez `portions`: porcje przepisu na JEDNEGO jedzącego po zapisie
   * (`plannedServings / jedzący`, reguła bilansu). Planer potrafi dać parze
   * 3 porcje — karta, która liczy talerz jako 1 porcję, mówiłaby o innym
   * dniu niż bilans po „Zapisz” (noc 26/27.09, N5).
   */
  servingsPerPerson?: number;
  /** Czy ta pozycja jest w tygodniu nowa, czy stała tam już wcześniej. */
  change: 'NEW' | 'KEPT';
};

/** Pozycja, która ZNIKNIE po zastosowaniu stanu docelowego. */
export type WeekPlanPreviewRemoval = {
  dayOfWeek: DayOfWeek;
  mealType: MealType;
  recipeId: string;
  title: string;
};

/**
 * Tydzień policzony, ale NIEZAPISANY.
 *
 * `applyWeekPlan(dryRun)` oddaje wyłącznie liczniki — dość, żeby model
 * wiedział, czy plan się spina, za mało, żeby cokolwiek pokazać człowiekowi.
 * Kartę propozycji składa serwer z bazy: model wskazuje przepisy, a nazwy,
 * kalorie i czasy pochodzą stąd, nie z jego pamięci.
 */
export type WeekPlanPreview = {
  violations: PlanViolation[];
  changes: { created: number; updated: number; deleted: number };
  /** `null`, gdy są naruszenia — nie ma czego pokazywać. */
  slots: WeekPlanPreviewSlot[] | null;
  removed: WeekPlanPreviewRemoval[] | null;
};

export type ApplyWeekPlanResult = {
  applied: boolean;
  dryRun: boolean;
  violations: PlanViolation[];
  changes: { created: number; updated: number; deleted: number };
  plan: Awaited<ReturnType<WeeklyPlansService['getByHouseholdAndWeek']>> | null;
};

@Injectable()
export class WeeklyPlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shoppingListService: ShoppingListService,
  ) {}
  /**
   * A single (day, mealType) slot may now hold several recipes — one per
   * household split. The caps scale accordingly: at most 6 variants in one
   * slot, so 7 days × 6 per meal type, times however many meal types exist.
   *
   * Limit całkowity liczy się z długości enuma, a nie ze stałej „3" — po
   * dołożeniu II śniadania i podwieczorka twardy sufit ucinałby plan
   * w połowie tygodnia u kogoś, kto po prostu włączył więcej posiłków.
   */
  private static readonly MAX_VARIANTS_PER_SLOT = 6;
  private static readonly MAX_ITEMS_PER_MEAL_TYPE = 7 * 6;
  private static readonly MAX_ITEMS_TOTAL =
    7 * 6 * MEAL_TYPES_IN_DAY_ORDER.length;

  /**
   * Plan tygodnia — zawsze w pełnym kształcie, także dla tygodnia, w którym
   * nikt jeszcze niczego nie zaplanował.
   *
   * Pusty tydzień NIE jest 404: iOS dekoduje `id` i `weekStart` jako pola
   * wymagane, a asystent (Faza 1) woła tę metodę in-process i „jeszcze nic
   * nie zaplanowano" jest dla niego zwykłym stanem, nie błędem. Dlatego brak
   * wiersza zakładamy przy odczycie — precedens już jest: `clearWeekPlan`
   * zostawia pusty wiersz, a `upsertWeekSlot` i tak by go założył przy
   * pierwszym posiłku. Dwa telefony otwierające ten sam tydzień naraz
   * ścigają się o `@@unique([householdId, weekStart])`: przegrany dostaje
   * P2002 i po prostu czyta wiersz, który założył wygrany.
   *
   * `weekStart` wychodzi jako `YYYY-MM-DD` — ten sam format, co w kopercie
   * i w broadcastach `weekChanged`; dotąd szedł tu pełny ISO datetime.
   */
  async getByHouseholdAndWeek(
    userId: string,
    householdId: string,
    weekStart: string,
  ) {
    await ensureMembership(this.prisma, userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);
    const where = {
      householdId_weekStart: { householdId, weekStart: weekStartDate },
    };
    const include = {
      items: {
        include: PLAN_ITEM_INCLUDE,
        orderBy: [{ mealType: 'asc' }, { createdAt: 'asc' }],
      },
    } satisfies Prisma.WeeklyPlanInclude;

    // Prisma czyta `include` OSOBNYMI zapytaniami (tydzień, pozycje, każda
    // relacja), a bez transakcji każde widzi inny stan (READ COMMITTED) —
    // zapis zatwierdzony w trakcie dawał `revision` sprzed zmiany z pozycjami
    // po niej. Token tygodnia musi opisywać DOKŁADNIE zwrócony stan, więc
    // odczyt idzie w jednej migawce (REPEATABLE READ: wszystkie zapytania
    // transakcji widzą stan z chwili pierwszego). Transakcja INTERAKTYWNA:
    // jednoelementowy `$transaction([...])` Prisma wysyła bez BEGIN (zmierzone
    // w logu Postgresa) i nic nie chroni.
    const readSnapshot = () =>
      this.prisma.$transaction(
        (tx) => tx.weeklyPlan.findUnique({ where, include }),
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );

    let plan = await readSnapshot();
    if (!plan) {
      await this.prisma.weeklyPlan
        .create({
          data: { householdId, weekStart: weekStartDate },
          select: { id: true },
        })
        .catch((error: unknown) => {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
          ) {
            return null;
          }
          throw error;
        });
      plan = await readSnapshot();
      if (!plan) throw new Error('weeklyPlan: brak wiersza tuż po założeniu');
    }

    return {
      ...plan,
      weekStart: formatWeekStart(plan.weekStart),
      items: plan.items.map(withPlanItemRelationIds),
    };
  }

  /**
   * Bilans tygodnia dla JEDNEGO domownika — ile z zaplanowanego przypada na
   * niego i ile z tego odhaczył jako zjedzone.
   *
   * Do Fazy 1 ta arytmetyka istniała wyłącznie w iOS: serwer trzymał surowe
   * `plannedServings` i „zjedzone", ale nie umiał odpowiedzieć na pytanie, od
   * którego zaczyna się każde planowanie — „czy ten dzień mieści się w celach
   * tej osoby". Asystent musi znać odpowiedź ZANIM pokaże propozycję.
   *
   * Reguły są portem 1:1 (`daily-balance.util.ts`), bo użytkownik widzi
   * dzienny licznik w aplikacji i porówna go z tym, co powie asystent.
   *
   * Zwracamy komplet siedmiu dni, także pustych, i sam bilans — bez celów
   * makro. Cele są w `households:memberPreferences` i to jest właściwe
   * miejsce: bilans nie ma powodu zaglądać do preferencji ani odwrotnie.
   */
  async weeklyBalance(
    userId: string,
    householdId: string,
    weekStart: string,
    memberUserId?: string,
  ) {
    await ensureMembership(this.prisma, userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);

    const memberIds = await this.loadMemberIds(householdId);
    const target = memberUserId ?? userId;
    if (memberUserId !== undefined) {
      assertUuid(memberUserId, 'memberUserId');
      if (!memberIds.has(memberUserId)) {
        throw new AppException(
          'PLAN_PARTICIPANT_NOT_IN_HOUSEHOLD',
          'Ta osoba nie należy do gospodarstwa.',
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    const items = await this.prisma.planItem.findMany({
      where: {
        weeklyPlan: { householdId, weekStart: weekStartDate },
      },
      select: {
        dayOfWeek: true,
        mealType: true,
        plannedServings: true,
        participants: { select: { userId: true } },
        consumptions: { select: { userId: true } },
        portions: { select: { userId: true, units: true } },
        recipe: {
          select: {
            servings: true,
            nutritionKcal: true,
            nutritionProtein: true,
            nutritionFat: true,
            nutritionCarbs: true,
            nutritionFiber: true,
          },
        },
      },
    });

    const days = weeklyBalanceForMember(
      items.map((item) => ({
        dayOfWeek: item.dayOfWeek,
        mealType: item.mealType,
        participantIds: item.participants.map((p) => p.userId),
        eatenByUserIds: item.consumptions.map((c) => c.userId),
        plannedServings: item.plannedServings,
        portions: toPortionViews(item.portions),
        recipe: item.recipe,
      })),
      {
        memberId: target,
        householdMemberCount: memberIds.size,
        days: DAYS_IN_WEEK_ORDER,
      },
    );

    return {
      weekStart: formatWeekStart(weekStartDate),
      userId: target,
      householdMemberCount: memberIds.size,
      days,
    };
  }

  async upsertWeekSlot(
    userId: string,
    householdId: string,
    weekStart: string,
    input: UpsertWeekSlotDto,
    /**
     * Tylko `logCookedMeal` (Gotuj, „Zjedzone” spoza planu): nowa pozycja
     * dostaje `cookedOffPlan`, istniejąca zostaje NIETKNIĘTA (to plan
     * domownika, nie nasz zapis), a `markEaten` biegnie w tej samej
     * transakcji, po zamku tygodnia — wpis i odhaczenie razem albo wcale.
     * `join` — gotujący DOCHODZI do audytorium istniejącej pozycji (zwykły
     * zapis planu z tokenem: porcje, bramki, lista zakupów jak przy ręcznym
     * dodaniu osoby) i jest odhaczony w tej samej transakcji.
     */
    cookLog?: {
      markEaten: (
        tx: Prisma.TransactionClient,
        planItemId: string,
      ) => Promise<void>;
      join?: boolean;
    },
  ) {
    // Walidacja na wejściu, PRZED pierwszym zapytaniem: dekoratory DTO nie
    // działają na WS, a asystent woła tę metodę in-process. Dalej używamy
    // ZWALIDOWANEJ instancji — ma wycięte nieznane pola.
    const dto = await validateDto(UpsertWeekSlotDto, input);
    await ensureMembership(this.prisma, userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);
    const replaceRecipeId = parseReplaceRecipeId(
      dto.replaceRecipeId,
      dto.recipeId,
    );
    assertReplaceTokens(dto, replaceRecipeId);
    assertPortionPolicyShape(dto.portionPolicy, dto.portions);
    await ensureRecipeForHousehold(this.prisma, dto.recipeId, householdId);
    // Jedno zapytanie o domowników (identyfikatory, alergeny)
    // zamiast czterech o ten sam skład — audyt 2: ręczne wstawienie posiłku
    // robiło ~8 zapytań przed transakcją.
    const members = await this.loadHouseholdMembersForGate(householdId);
    const resolved = await this.resolveParticipants(
      householdId,
      dto.participantIds,
      members.memberIds,
    );
    const participantIds = resolved.participantIds;
    // Podmiana potrzebuje IDENTYFIKATORÓW domowników, nie tylko ich liczby:
    // przejęte audytorium starego dania trzeba przeciąć z żywym składem domu,
    // bo item mógł zapamiętać byłego domownika (duch po `leave`), a taki wpis
    // nie ma prawa wejść do nowego itemu. Liczba domowników pochodzi wtedy z
    // tej samej listy, żeby obie reguły liczyły z jednego stanu.
    const memberIds = replaceRecipeId ? members.memberIds : null;
    const memberCount = memberIds ? memberIds.size : resolved.memberCount;
    // Reguła auto dla NOWEGO itemu. Liczymy z już rozwiązanego audytorium, nie
    // z surowego `dto`: lista nazywająca wszystkich domowników zwija się do
    // pustej („Wspólne"), więc obie formy tego samego wyboru muszą dać tyle
    // samo porcji. Istniejący item ma własną regułę — patrz
    // `resolveUpdatedPlannedServings` niżej.
    const plannedServingsForCreate = this.resolvePlannedServings(
      participantIds,
      memberCount,
      dto.plannedServings,
    );

    // Te same twarde bramki, co w `applyWeekPlan` (alergeny domowników). Do 3.09.2026 miał je tylko zapis tygodnia — asystent nie
    // mógł wstawić dania z alergenem, a ręka z telefonu mogła. Ładowane
    // PRZED transakcją, sprawdzane w niej, gdy znane jest już audytorium.
    const plannableForGate = await this.loadPlannableRecipes(householdId, [
      dto.recipeId,
    ]);
    const { allergensByMember } = members;
    const memberIdsForGate = members.memberIds;

    const result = await this.prisma.$transaction(async (tx) => {
      // KOLEJNOŚĆ BLOKAD — ta sama w każdej transakcji zmieniającej tydzień:
      // zamek tygodnia → stan archiwum → pozycje planu → lista zakupów.
      // Zamek idzie PIERWSZY: kto na nim czeka, nie trzyma jeszcze niczego,
      // więc nie ma na co czekać nawzajem (`test/week-lock-order.e2e-spec.ts`).
      // Tydzień, którego jeszcze nie ma, zakłada `upsert` — równoległych
      // założycieli szereguje indeks unikalny (householdId, weekStart).
      const weeklyPlan = await tx.weeklyPlan.upsert({
        where: {
          householdId_weekStart: {
            householdId,
            weekStart: weekStartDate,
          },
        },
        update: {},
        create: {
          householdId,
          weekStart: weekStartDate,
        },
        select: { id: true },
      });
      await lockWeekForWrite(tx, weeklyPlan.id);
      // Członkostwo jeszcze raz, już pod zamkiem — patrz `ensureMembershipInTx`.
      await ensureMembershipInTx(tx, userId, householdId, participantIds);
      // Rewizja tygodnia +1 raz na transakcję, przy pierwszym zapisie treści;
      // ta wartość stempluje zmienione pozycje i porcje. Ack NIE niesie
      // rewizji tygodnia: token tygodnia wolno brać wyłącznie z pełnego
      // odczytu (ADR `plan-portions-safe-editing`, decyzja 1).
      let stamp: number | null = null;
      const nextStamp = async (): Promise<number> => {
        if (stamp === null) stamp = await bumpWeekRevision(tx, weeklyPlan.id);
        return stamp;
      };

      // Wpis po gotowaniu (`cookLog`) listy zakupów nie zmienia
      // (`cookedOffPlan`), więc nie odsłania listy schowanej po wyczyszczeniu
      // historii i nie każe jej przeliczać.
      if (!cookLog || cookLog.join) {
        await tx.shoppingListArchiveState.deleteMany({
          where: {
            householdId,
            weekStart: weekStartDate,
            currentArchiveId: null,
          },
        });
      }

      // „Zmień danie": stary wariant znika w tej samej transakcji, w której
      // wchodzi nowy. Dwa skutki, oba celowe: slot nigdy nie stoi pusty
      // (klient nie woła już `removeWeekSlot` + `upsertWeekSlot`), a limity
      // niżej liczą się PO usunięciu — podmiana w pełnym slocie nie odbija się
      // o cap, który sama zwalnia. Kaskada zabiera uczestników i znaczniki
      // zjedzenia, dokładnie tak, jak robiło to dotychczasowe `removeWeekSlot`.
      // Brak starego itemu (drugi telefon zdążył go usunąć) nie jest błędem:
      // zapis degraduje się do zwykłego wstawienia.
      const replaced = replaceRecipeId
        ? await tx.planItem.findFirst({
            where: {
              weeklyPlanId: weeklyPlan.id,
              dayOfWeek: dto.dayOfWeek,
              mealType: dto.mealType,
              recipeId: replaceRecipeId,
            },
            select: {
              id: true,
              revision: true,
              plannedServings: true,
              participants: { select: { userId: true } },
              portions: { select: { userId: true, units: true } },
            },
          })
        : null;
      // The item is identified by its recipe, not just by the slot: a slot can
      // hold one variant per household split. Re-upserting the same recipe
      // only rewrites who it is for. Przy zamianie to CEL (przepis, który już
      // leży w slocie obok) — szukany PRZED usunięciem źródła, bo jego token
      // też trzeba sprawdzić, zanim cokolwiek się zmieni.
      //
      // Dociągamy tu porcje i STARE audytorium, mimo że za chwilę je kasujemy:
      // bez nich nie da się orzec, czy zapisana liczba porcji to wynik reguły
      // auto, czy świadomy wybór użytkownika (patrz
      // `resolveUpdatedPlannedServings`).
      const existingItem = await tx.planItem.findFirst({
        where: {
          weeklyPlanId: weeklyPlan.id,
          dayOfWeek: dto.dayOfWeek,
          mealType: dto.mealType,
          recipeId: dto.recipeId,
        },
        select: {
          id: true,
          revision: true,
          plannedServings: true,
          participants: { select: { userId: true } },
          portions: { select: { userId: true, units: true } },
        },
      });

      // Tokeny (`expectedRevision`, `expectedTargetRevision`) = stemple pozycji
      // z odczytu klienta. Bez zamiany — tej pozycji. Przy zamianie — źródła
      // ORAZ celu (parę wymusza `assertReplaceTokens`): `null` celu = „celu
      // nie ma w slocie”. Cokolwiek się nie zgadza — źródło zniknęło albo
      // zmieniło się, cel powstał, zniknął, zmienił się albo został odtworzony
      // — klient zamienia stan, którego już nie ma: konflikt, nic nie zmienione.
      const expectedRevision = dto.expectedRevision;
      const expectedTargetRevision = dto.expectedTargetRevision;
      // PRESERVE przenosi porcje, ale zamiana nadal usuwa źródło i może
      // przepisać cel. Intencja musi dotyczyć obu odczytanych wersji.
      if (
        replaceRecipeId &&
        dto.portionPolicy === 'PRESERVE' &&
        expectedRevision === undefined
      ) {
        throw revisionRequired(replaced?.id ?? existingItem?.id ?? '');
      }
      if (replaceRecipeId && expectedRevision !== undefined) {
        if (!replaced || replaced.revision !== expectedRevision) {
          throw revisionConflict(replaced);
        }
        const targetMatches =
          expectedTargetRevision === null
            ? !existingItem
            : existingItem?.revision === expectedTargetRevision;
        if (!targetMatches) throw revisionConflict(existingItem);
      }
      if (!replaceRecipeId && expectedRevision !== undefined && !existingItem) {
        // Token bez zamiany celuje w TĘ pozycję — nie ma jej (usunięta albo
        // jeszcze nieodtworzona), więc klient pisze do stanu, którego nie ma.
        throw revisionConflict(null);
      }
      // Gotuj: przepis zdążył trafić do tego slotu (drugi telefon, ponowienie
      // po utraconej odpowiedzi) — odhaczamy go tam, nie ruszając audytorium
      // ani porcji, które ustawił ktoś inny.
      if (cookLog && !cookLog.join && existingItem) {
        await cookLog.markEaten(tx, existingItem.id);
        const kept = await tx.planItem.findUniqueOrThrow({
          where: { id: existingItem.id },
          include: PLAN_ITEM_INCLUDE,
        });
        return {
          ...withPlanItemRelationIds(kept),
          replacedItemIds: [] as string[],
          changeKind: 'NOOP' as const,
        };
      }
      // Porcje z żądania — potrzebne już tu: zamiana dania z alokacją BEZ
      // jawnych porcji usunęłaby ją razem z pozycją, a z jawnymi, ale bez
      // tokenu — zastąpiła. Decyzja zapada pod zamkiem tygodnia, na pozycji
      // odczytanej w tej transakcji, PRZED usunięciem źródła (ADR-y
      // `plan-portions-write-safety`, `plan-portions-safe-editing`).
      const portions = normalizedPortions(dto.portions);
      // Jawna intencja (`portionPolicy`); bez pola — z kształtu (legacy):
      // porcje podane = REPLACE, pominięte = LEGACY (nigdy cichy RESET).
      const intent = portionIntentOf(dto.portionPolicy, portions);
      if (replaced && replaced.portions.length > 0) {
        // LEGACY: klient nie wie o alokacji — zamiana usunęłaby ją po cichu.
        if (intent === 'LEGACY') throw portionsConflict(replaced.id);
        // RESET kasuje alokację źródła — tylko ze zweryfikowanym zapisem.
        if (intent === 'RESET' && expectedRevision === undefined) {
          throw revisionRequired(replaced.id);
        }
        // PRESERVE: porcje osób przechodzą na nowe danie (niżej, gdy znane
        // jest audytorium). REPLACE: decyzja jak dotąd.
      }
      if (replaced && replaced.portions.length > 0 && intent === 'REPLACE') {
        const sourceDecision = portionsWriteDecision(
          {
            participantIds: replaced.participants.map((p) => p.userId),
            plannedServings: replaced.plannedServings,
            portions: toPortionViews(replaced.portions),
          },
          {
            participantIds: [],
            plannedServings: dto.plannedServings,
            portions,
          },
          expectedRevision !== undefined ? 'verified' : 'strict',
        );
        if (sourceDecision === 'REVISION_REQUIRED') {
          throw revisionRequired(replaced.id);
        }
      }
      if (replaced) {
        await nextStamp();
        await tx.planItem.delete({ where: { id: replaced.id } });
      }
      const replacedItemIds = replaced ? [replaced.id] : [];

      // Audytorium nowego itemu. Jawne `participantIds` wygrywa zawsze;
      // pominięte przy podmianie przejmuje audytorium starego dania, bo „zmień
      // danie" nie jest pytaniem o to, KTO je — tylko CO. Imienny zbiór, z
      // którego po odsianiu duchów zostali wszyscy domownicy (albo nikt),
      // zwija się do „Wspólne", tak samo jak w `resolveParticipants`.
      let effectiveParticipantIds = participantIds;
      if (replaced && memberIds && dto.participantIds === undefined) {
        const carried = replaced.participants
          .map((p) => p.userId)
          .filter((id) => memberIds.has(id));
        effectiveParticipantIds =
          carried.length === 0 || carried.length === memberIds.size
            ? []
            : carried;
      }

      // Bramka po ustaleniu audytorium: jedno „nie jem" nie wykreśla dania
      // tym, którzy jedzą je bez problemu. Slot (śniadanie/kolacja) tu NIE
      // jest sprawdzany — telefon nie filtruje przepisów po slocie, więc
      // odmowa zaskoczyłaby użytkownika; to decyzja produktowa, nie zdrowie.
      const violation = this.collectPlanViolations(
        [
          {
            dayOfWeek: dto.dayOfWeek,
            mealType: dto.mealType,
            recipeId: dto.recipeId,
            participantIds: effectiveParticipantIds,
          },
        ],
        plannableForGate,
        memberIdsForGate,
        allergensByMember,
      ).find(
        (entry) =>
          entry.code === 'RECIPE_ALLERGEN_CONFLICT' ||
          entry.code === 'RECIPE_EXCLUDED_INGREDIENT',
      );
      if (violation) {
        throw new AppException(
          violation.code,
          violation.message,
          HttpStatus.BAD_REQUEST,
        );
      }

      // Osoby jedzące po zapisie — dla „Wspólne” wszyscy domownicy.
      const audienceIds = [
        ...(effectiveParticipantIds.length > 0
          ? effectiveParticipantIds
          : memberIdsForGate),
      ];
      // Zamiana z PRESERVE (= KEEP): porcje osób ze źródła przechodzą na nowe
      // danie, przeliczone na jego audytorium (zostający — swoja porcja, nowi
      // — 1,00). Serwer, nie klient.
      const carriedPortions =
        replaced && intent === 'PRESERVE' && replaced.portions.length > 0
          ? remapPortions(toPortionViews(replaced.portions), audienceIds)
          : [];
      // Porcje, które zapis chce ustawić: jawne (REPLACE) albo przeniesione.
      const requestedPortions =
        intent === 'REPLACE' ? portions : carriedPortions;

      // Porcje per osoba (Etap 2.2): podane = źródło prawdy dla audytorium
      // tej pozycji. POMINIĘTE (albo `[]`) nie kasują już alokacji, którą
      // pozycja ma — decyzja niżej (`planPortionsForExisting`).
      if (requestedPortions.length > 0) {
        const problem =
          portionsProblem(requestedPortions, new Set(audienceIds)) ??
          (intent === 'PRESERVE' &&
          dto.plannedServings != null &&
          dto.plannedServings !== derivedPlannedServings(requestedPortions)
            ? PRESERVE_SERVINGS_PROBLEM
            : null);
        if (problem) throw portionsInvalid(problem);
      }

      if (existingItem) {
        const currentParticipantIds = existingItem.participants.map(
          (p) => p.userId,
        );
        const currentPortions = toPortionViews(existingItem.portions);
        // Zweryfikowana jest pozycja, której token klient podał: bez zamiany —
        // `expectedRevision`, przy zamianie — `expectedTargetRevision` celu
        // (zgodny, bo niezgodny skończył się wyżej konfliktem). Cel zamiany
        // bez tokenów (legacy) zostaje `strict`.
        const tokenGiven = replaceRecipeId
          ? expectedTargetRevision != null
          : expectedRevision !== undefined;
        const tokenStale =
          !replaceRecipeId &&
          tokenGiven &&
          expectedRevision !== existingItem.revision;
        // Decyzja i docelowa alokacja z intencji (`planPortionsForExisting`):
        // - LEGACY: identyczny zapis = KEEP, zmiana = CONFLICT (#209);
        // - REPLACE: jawne porcje inne niż bieżące tylko ze zgodnym tokenem;
        // - PRESERVE: alokacja przeliczona na nowe audytorium, bez tokenu;
        // - RESET: usunięcie alokacji tylko ze zgodnym tokenem.
        // Porcje przeniesione przy zamianie zastępują alokację CELU (REPLACE
        // wobec celu). Nieaktualny token liczy się jak zgodny, żeby orzec,
        // czy zapis w ogóle coś zmienia — jeśli tak, niżej i tak konflikt.
        const targetIntent = carriedPortions.length > 0 ? 'REPLACE' : intent;
        const plan = planPortionsForExisting(
          {
            participantIds: currentParticipantIds,
            plannedServings: existingItem.plannedServings,
            portions: currentPortions,
          },
          {
            participantIds: effectiveParticipantIds,
            plannedServings: dto.plannedServings,
            portions: targetIntent === 'REPLACE' ? requestedPortions : [],
            intent: targetIntent,
            audience: audienceIds,
          },
          tokenGiven ? 'verified' : 'strict',
        );
        const decision = plan.decision;
        const finalPortions = plan.portions;
        // Pozycja zostaje nietknięta (KEEP albo zapis bez różnicy): nic nie
        // jest zapisywane ani stemplowane.
        const keepAsIs = async () => {
          // Usunięte źródło zamiany zmienia listę zakupów; sama pozycja nie.
          if (replaced) {
            await this.shoppingListService.markShoppingListStale(
              householdId,
              weekStartDate,
              tx,
            );
          }
          if (cookLog) await cookLog.markEaten(tx, existingItem.id);
          const kept = await tx.planItem.findUniqueOrThrow({
            where: { id: existingItem.id },
            include: PLAN_ITEM_INCLUDE,
          });
          return {
            ...withPlanItemRelationIds(kept),
            replacedItemIds,
            changeKind: replaced ? ('REPLACED' as const) : ('NOOP' as const),
          };
        };
        if (decision === 'KEEP') return keepAsIs();
        const plannedServingsForUpdate =
          finalPortions.length > 0
            ? derivedPlannedServings(finalPortions)
            : this.resolveUpdatedPlannedServings({
                currentPlannedServings: existingItem.plannedServings,
                currentParticipantIds,
                nextParticipantIds: effectiveParticipantIds,
                memberCount,
                requested: dto.plannedServings,
              });

        // Przepis jest częścią klucza wyszukania, więc trafienie w istniejący
        // item ZNACZY, że danie się nie zmieniło — ruszyły najwyżej porcje albo
        // audytorium. Bramka jest tu, a nie w gatewayu, bo tylko ta strona zna
        // stan sprzed zapisu; gateway dostaje gotową odpowiedź i po niej
        // decyduje, czy zawracać głowę drugiemu domownikowi (patrz
        // `weekly-plans.gateway.ts`, `weeklyPlans:upsertWeekSlot`).
        // Podmiana na przepis, który już leżał w slocie obok, też jest
        // zdarzeniem dla domownika: jedno danie zniknęło.
        const detailsChanged =
          plannedServingsForUpdate !== existingItem.plannedServings ||
          !sameMemberSet(currentParticipantIds, effectiveParticipantIds) ||
          !samePortions(currentPortions, finalPortions);

        // Nieaktualny token: zapis, który coś by zmienił, nie wchodzi — także
        // ponowienie, po którym ktoś zdążył zmienić pozycję. Zapis bez różnicy
        // (np. ponowienie po utraconej odpowiedzi) jest sukcesem bez zmian.
        if (tokenStale && (decision !== 'WRITE' || detailsChanged)) {
          throw revisionConflict(existingItem);
        }
        if (decision === 'INVALID') {
          throw portionsInvalid(plan.problem ?? PRESERVE_SERVINGS_PROBLEM);
        }
        if (decision === 'CONFLICT') throw portionsConflict(existingItem.id);
        if (decision === 'REVISION_REQUIRED') {
          throw revisionRequired(existingItem.id);
        }
        if (!detailsChanged) return keepAsIs();

        const revision = await nextStamp();
        await tx.planItemParticipant.deleteMany({
          where: { planItemId: existingItem.id },
        });
        const updatedItem = await tx.planItem.update({
          where: { id: existingItem.id },
          data: {
            plannedServings: plannedServingsForUpdate,
            revision,
            participants: {
              create: effectiveParticipantIds.map((id) => ({ userId: id })),
            },
            portions: {
              deleteMany: {},
              create: stampedPortionRows(finalPortions, revision),
            },
          },
          include: PLAN_ITEM_INCLUDE,
        });
        await this.shoppingListService.markShoppingListStale(
          householdId,
          weekStartDate,
          tx,
        );
        // Gotuj (`join`): odhaczenie w tej samej transakcji, odczyt po nim.
        const finalItem = cookLog
          ? await cookLog.markEaten(tx, existingItem.id).then(() =>
              tx.planItem.findUniqueOrThrow({
                where: { id: existingItem.id },
                include: PLAN_ITEM_INCLUDE,
              }),
            )
          : updatedItem;

        return {
          ...withPlanItemRelationIds(finalItem),
          replacedItemIds,
          changeKind: replaced
            ? ('REPLACED' as const)
            : ('DETAILS_CHANGED' as const),
        };
      }

      const [existingForMealType, existingTotal, variantsInSlot] =
        await Promise.all([
          tx.planItem.count({
            where: {
              weeklyPlanId: weeklyPlan.id,
              mealType: dto.mealType,
            },
          }),
          tx.planItem.count({
            where: { weeklyPlanId: weeklyPlan.id },
          }),
          tx.planItem.count({
            where: {
              weeklyPlanId: weeklyPlan.id,
              dayOfWeek: dto.dayOfWeek,
              mealType: dto.mealType,
            },
          }),
        ]);

      if (variantsInSlot >= WeeklyPlansService.MAX_VARIANTS_PER_SLOT) {
        throw new AppException(
          'PLAN_SLOT_VARIANT_LIMIT_REACHED',
          `Slot variant limit reached (max ${WeeklyPlansService.MAX_VARIANTS_PER_SLOT} per meal)`,
          HttpStatus.BAD_REQUEST,
        );
      }

      if (existingForMealType >= WeeklyPlansService.MAX_ITEMS_PER_MEAL_TYPE) {
        throw new AppException(
          'PLAN_SLOT_LIMIT_REACHED',
          `Meal type limit reached (max ${WeeklyPlansService.MAX_ITEMS_PER_MEAL_TYPE} per week)`,
          HttpStatus.BAD_REQUEST,
        );
      }

      if (existingTotal >= WeeklyPlansService.MAX_ITEMS_TOTAL) {
        throw new AppException(
          'PLAN_TOTAL_LIMIT_REACHED',
          `Weekly plan total limit reached (max ${WeeklyPlansService.MAX_ITEMS_TOTAL} items)`,
          HttpStatus.BAD_REQUEST,
        );
      }

      // Porcje po podmianie liczą się jak przy edycji istniejącego itemu:
      // ręcznie wybrana liczba przeżywa zmianę dania, wartość z reguły auto
      // przelicza się z nowego audytorium. Bez tego „zmień danie" cofałoby
      // świadome „gotuję 4 porcje" do auto — dokładnie to, przed czym
      // `resolveUpdatedPlannedServings` broni stepper.
      const plannedServings =
        requestedPortions.length > 0
          ? derivedPlannedServings(requestedPortions)
          : replaced
            ? this.resolveUpdatedPlannedServings({
                currentPlannedServings: replaced.plannedServings,
                currentParticipantIds: replaced.participants.map(
                  (p) => p.userId,
                ),
                nextParticipantIds: effectiveParticipantIds,
                memberCount,
                requested: dto.plannedServings,
              })
            : plannedServingsForCreate;

      const revision = await nextStamp();
      const createdItem = await tx.planItem
        .create({
          data: {
            weeklyPlanId: weeklyPlan.id,
            dayOfWeek: dto.dayOfWeek,
            mealType: dto.mealType,
            recipeId: dto.recipeId,
            plannedServings,
            revision,
            cookedOffPlan: cookLog !== undefined && !cookLog.join,
            participants: {
              create: effectiveParticipantIds.map((id) => ({ userId: id })),
            },
            ...(requestedPortions.length > 0
              ? {
                  portions: {
                    create: stampedPortionRows(requestedPortions, revision),
                  },
                }
              : {}),
          },
          include: PLAN_ITEM_INCLUDE,
        })
        .catch((error: unknown) => {
          // Wyścig dwóch telefonów o ten sam przepis w tym samym slocie:
          // `findFirst` wyżej nie widział itemu, który druga transakcja
          // właśnie zapisała, i dopiero unikalny indeks go ujawnia. Do klienta
          // ma trafić czytelny konflikt, nie INTERNAL_ERROR.
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
          ) {
            throw new AppException(
              'PLAN_SLOT_DUPLICATE',
              'This recipe is already assigned to that day and meal slot',
              HttpStatus.CONFLICT,
            );
          }
          throw error;
        });

      if (cookLog?.join) {
        await this.shoppingListService.markShoppingListStale(
          householdId,
          weekStartDate,
          tx,
        );
      }
      if (cookLog) {
        await cookLog.markEaten(tx, createdItem.id);
        // Odczyt po odhaczeniu — `consumptions` w odpowiedzi ma je już mieć.
        const eaten = await tx.planItem.findUniqueOrThrow({
          where: { id: createdItem.id },
          include: PLAN_ITEM_INCLUDE,
        });
        return {
          ...withPlanItemRelationIds(eaten),
          replacedItemIds,
          changeKind: 'CREATED' as const,
        };
      }

      await this.shoppingListService.markShoppingListStale(
        householdId,
        weekStartDate,
        tx,
      );

      return {
        ...withPlanItemRelationIds(createdItem),
        replacedItemIds,
        changeKind: replaced ? ('REPLACED' as const) : ('CREATED' as const),
      };
    });
    // Panel (kanał na żywo): pulpit liczy dania w planach. Po commicie.
    emitLive({ topics: ['dashboard'] });
    return result;
  }

  /**
   * Cały tydzień w JEDNEJ transakcji — stan docelowy, nie lista poprawek.
   *
   * Dotąd plan dało się zmieniać wyłącznie per slot: 21 posiłków to 21–42
   * wywołania, każde z własną transakcją i własnym broadcastem, a błąd przy
   * szesnastym zostawiał pół tygodnia i klienta bez informacji, które połowa
   * weszła. Dla asystenta, który układa tydzień naraz, to nie jest stan, z
   * którego da się wyjść.
   *
   * Trzy decyzje, które warto znać:
   *
   * 1. **Stan docelowy, nie diff od klienta.** Wołający przysyła tydzień taki,
   *    jaki ma być; my liczymy różnicę wobec bazy. Inaczej trzeba by zgadywać,
   *    czy pominięty slot znaczy „usuń", czy „nie ruszaj".
   * 2. **Różnica, a nie `clearWeekPlan` + zapis od nowa.** Kasowanie tygodnia
   *    zabiera ze sobą archiwa list zakupów (`clearWeekPlan` czyści
   *    `shoppingListArchive*`), więc „przeplanuj" niszczyłoby historię
   *    zakupów za każdym razem. Ruszamy wyłącznie te itemy, które naprawdę
   *    się zmieniły — niezmieniony slot nie jest nawet zapisywany.
   * 3. **Naruszenia wracają LISTĄ, nie wyjątkiem — i nic się nie zapisuje.**
   *    Wyjątek mówi o pierwszym problemie; asystent poprawiłby jeden slot,
   *    wysłał ponownie i dowiedział się o kolejnym. Zwracamy wszystkie naraz,
   *    a plan zostaje nietknięty także wtedy, gdy `dryRun` jest `false`:
   *    połowa tygodnia to gorszy wynik niż brak zmian.
   *
   * Limity liczą się od stanu DOCELOWEGO, nie od sumy „obecne + nowe" —
   * po zastosowaniu w tygodniu jest dokładnie to, co przyszło w `slots`.
   */
  async applyWeekPlan(
    userId: string,
    householdId: string,
    weekStart: string,
    input: ApplyWeekPlanDto,
    hooks: ApplyWeekPlanHooks = {},
  ): Promise<ApplyWeekPlanResult> {
    // `verified` i `authoritative` zdejmują ochronę porcji — wolno
    // WYŁĄCZNIE z `guard`, który w tej samej transakcji sprawdza odcisk
    // tygodnia (zapis i cofnięcie propozycji). Bez niego nic nie chroni
    // alokacji: odmowa przed zapisem.
    if (
      (hooks.portionsPolicy === 'authoritative' ||
        hooks.portionsPolicy === 'verified') &&
      !hooks.guard
    ) {
      throw new Error(
        `applyWeekPlan: portionsPolicy "${hooks.portionsPolicy}" wymaga guarda sprawdzającego odcisk tygodnia w tej samej transakcji.`,
      );
    }
    if (hooks.dietScope === 'none' && !hooks.guard) {
      throw new Error(
        'applyWeekPlan: dietScope "none" wymaga guarda sprawdzającego odcisk tygodnia w tej samej transakcji.',
      );
    }
    const dto = await validateDto(ApplyWeekPlanDto, input);
    await ensureMembership(this.prisma, userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);
    const dryRun = dto.dryRun === true;

    const { memberIds, allergensByMember, dietByMember } =
      await this.loadHouseholdMembersForGate(householdId);
    const recipes = await this.loadPlannableRecipes(
      householdId,
      dto.slots.map((slot) => slot.recipeId),
    );
    // Odczyt poza zamkiem tygodnia, jak cała walidacja: równoległa edycja
    // między nim a zapisem może najwyżej przepuścić danie, które człowiek
    // właśnie usunął — to samo „ostatni zapis wygrywa”, co dla reszty pól.
    // Propozycje chroni odcisk tygodnia w `guard`.
    const dietGate =
      hooks.dietScope === 'none'
        ? null
        : {
            dietByMember,
            current: await this.loadCurrentAudiences(
              householdId,
              weekStartDate,
              memberIds,
            ),
          };

    const violations = this.collectPlanViolations(
      dto.slots,
      recipes,
      memberIds,
      allergensByMember,
      undefined,
      dietGate,
    );
    if (violations.length > 0) {
      return {
        applied: false,
        dryRun,
        violations,
        changes: { created: 0, updated: 0, deleted: 0 },
        plan: null,
      };
    }

    for (const slot of dto.slots) {
      assertPortionPolicyShape(slot.portionPolicy, slot.portions);
    }
    const desired = this.desiredSlots(dto.slots, memberIds);

    if (dryRun) {
      // Ten sam token i ta sama decyzja porcji co w zapisie, ale na odczycie
      // bez zamka — doradczo; wiążąca jest kontrola w transakcji niżej.
      const week = await this.prisma.weeklyPlan.findUnique({
        where: {
          householdId_weekStart: { householdId, weekStart: weekStartDate },
        },
        select: { revision: true },
      });
      const currentRevision = week?.revision ?? 0;
      if (
        dto.expectedRevision !== undefined &&
        dto.expectedRevision !== currentRevision
      ) {
        return {
          applied: false,
          dryRun,
          violations: [weekRevisionConflict()],
          changes: { created: 0, updated: 0, deleted: 0 },
          plan: null,
        };
      }
      const portions = await this.advisoryPortions(
        householdId,
        weekStartDate,
        desired,
        effectivePolicy(hooks.portionsPolicy, dto.expectedRevision),
        memberIds,
      );
      if (portions.conflicts.length > 0) {
        return {
          applied: false,
          dryRun,
          violations: portions.conflicts,
          changes: { created: 0, updated: 0, deleted: 0 },
          plan: null,
        };
      }
      const changes = await this.previewWeekPlanChanges(
        householdId,
        weekStartDate,
        portions.settled,
        portions.keep,
        portions.planned,
      );
      return { applied: false, dryRun, violations: [], changes, plan: null };
    }

    const outcome = await runSerializable(this.prisma, async (tx) => {
      const weeklyPlan = await tx.weeklyPlan.upsert({
        where: {
          householdId_weekStart: { householdId, weekStart: weekStartDate },
        },
        update: {},
        create: { householdId, weekStart: weekStartDate },
        select: { id: true },
      });
      // Zamek jako PIERWSZA blokada transakcji (kolejność jak w
      // `upsertWeekSlot`) i PRZED odczytem pozycji: wszystko niżej — także
      // warunki z `guard` — liczy się na stanie, którego nikt równolegle
      // nie zmienia.
      const lockedRevision = await lockWeekForWrite(tx, weeklyPlan.id);
      // Token pełnego stanu: tydzień zmienił się od odczytu klienta — nic nie
      // wchodzi (także ponowienie po utraconej odpowiedzi; klient odświeża).
      if (
        dto.expectedRevision !== undefined &&
        dto.expectedRevision !== lockedRevision
      ) {
        throw new PortionsConflictRefusal([weekRevisionConflict()]);
      }
      const policy = effectivePolicy(
        hooks.portionsPolicy,
        dto.expectedRevision,
      );
      let stamp: number | null = null;
      const nextStamp = async (): Promise<number> => {
        if (stamp === null) stamp = await bumpWeekRevision(tx, weeklyPlan.id);
        return stamp;
      };
      await ensureMembershipInTx(
        tx,
        userId,
        householdId,
        desired.flatMap((slot) => slot.participantIds),
      );

      // Stan archiwum listy zakupów dla tygodnia bez archiwum jest
      // nieaktualny z chwilą zmiany planu.
      await tx.shoppingListArchiveState.deleteMany({
        where: {
          householdId,
          weekStart: weekStartDate,
          currentArchiveId: null,
        },
      });

      const current = await tx.planItem.findMany({
        where: { weeklyPlanId: weeklyPlan.id },
        select: {
          id: true,
          dayOfWeek: true,
          mealType: true,
          recipeId: true,
          plannedServings: true,
          participants: { select: { userId: true } },
          portions: { select: { userId: true, units: true } },
        },
      });
      if (hooks.guard) {
        await hooks.guard(
          tx,
          current.map((item) => ({
            dayOfWeek: item.dayOfWeek,
            mealType: item.mealType,
            recipeId: item.recipeId,
            participantIds: item.participants.map((p) => p.userId),
            plannedServings: item.plannedServings,
            ...withPortions(toPortionViews(item.portions)),
          })),
        );
      }

      const currentByKey = new Map(
        current.map((item) => [planSlotKey(item), item]),
      );
      const desiredKeys = new Set(desired.map((slot) => slot.key));
      // Ten sam zbiór osób co zapisany = bez zmiany reprezentacji audytorium.
      const settled = settleParticipants(desired, currentByKey);

      // Porcje per osoba — decyzja pod zamkiem, na pozycjach odczytanych w tej
      // transakcji, PRZED jakimkolwiek zapisem. Odmowa wycofuje całą
      // transakcję (także to, co zrobił `guard`) i wraca niżej jako naruszenia.
      const portionsDecisions = this.portionsDecisions(
        settled,
        currentByKey,
        policy,
        memberIds,
      );
      if (portionsDecisions.conflicts.length > 0) {
        throw new PortionsConflictRefusal(portionsDecisions.conflicts);
      }

      const removedIds = current
        .filter((item) => !desiredKeys.has(planSlotKey(item)))
        .map((item) => item.id);
      if (removedIds.length > 0) {
        await nextStamp();
        // Kaskada zabiera uczestników i znaczniki zjedzenia — dokładnie tak,
        // jak przy `removeWeekSlot`. Archiwa list zakupów zostają.
        await tx.planItem.deleteMany({ where: { id: { in: removedIds } } });
      }

      let created = 0;
      let updated = 0;
      for (const slot of settled) {
        const existing = currentByKey.get(slot.key);
        // Pozycja z alokacją, której slot bez porcji niczego nie zmienia —
        // zostaje nietknięta (nie liczy się jako zmiana).
        if (existing && portionsDecisions.keep.has(slot.key)) continue;
        // Alokacja do zapisania — z intencji slotu (`planPortionsForExisting`).
        const finalPortions = portionsDecisions.planned.get(slot.key) ?? [];
        if (!existing) {
          const revision = await nextStamp();
          await tx.planItem.create({
            data: {
              weeklyPlanId: weeklyPlan.id,
              dayOfWeek: slot.dayOfWeek,
              mealType: slot.mealType,
              recipeId: slot.recipeId,
              revision,
              plannedServings:
                finalPortions.length > 0
                  ? derivedPlannedServings(finalPortions)
                  : this.resolvePlannedServings(
                      slot.participantIds,
                      memberIds.size,
                      slot.plannedServings,
                    ),
              participants: {
                create: slot.participantIds.map((id) => ({ userId: id })),
              },
              ...(finalPortions.length > 0
                ? {
                    portions: {
                      create: stampedPortionRows(finalPortions, revision),
                    },
                  }
                : {}),
            },
          });
          created += 1;
          continue;
        }

        const currentParticipantIds = existing.participants.map(
          (p) => p.userId,
        );
        const currentPortions = toPortionViews(existing.portions);
        const plannedServings =
          finalPortions.length > 0
            ? derivedPlannedServings(finalPortions)
            : this.resolveUpdatedPlannedServings({
                currentPlannedServings: existing.plannedServings,
                currentParticipantIds,
                nextParticipantIds: slot.participantIds,
                memberCount: memberIds.size,
                requested: slot.plannedServings,
              });
        const participantsChanged = !sameIdSet(
          currentParticipantIds,
          slot.participantIds,
        );
        const portionsChanged = !samePortions(currentPortions, finalPortions);
        if (
          !participantsChanged &&
          !portionsChanged &&
          plannedServings === existing.plannedServings
        ) {
          // Slot bez zmian nie jest zapisywany — inaczej „przeplanuj tydzień"
          // odświeżałoby `updatedAt` na wszystkim i psuło ewentualny audyt.
          continue;
        }

        const revision = await nextStamp();
        await tx.planItem.update({
          where: { id: existing.id },
          data: {
            plannedServings,
            revision,
            ...(participantsChanged
              ? {
                  participants: {
                    deleteMany: {},
                    create: slot.participantIds.map((id) => ({ userId: id })),
                  },
                }
              : {}),
            // Każda zmiana pozycji przestemplowuje WSZYSTKIE jej porcje, jak
            // w `upsertWeekSlot` — także zmiana samego audytorium przy tych
            // samych wartościach (jawna lista wszystkich → „Wspólne”): pełny
            // zapis struktury pozycji unieważnia tokeny porcji. Atomowa edycja
            // jednej osoby to `setPortion`.
            portions: {
              deleteMany: {},
              create: stampedPortionRows(finalPortions, revision),
            },
          },
        });
        updated += 1;
      }

      await this.shoppingListService.markShoppingListStale(
        householdId,
        weekStartDate,
        tx,
      );

      const changes = { created, updated, deleted: removedIds.length };
      if (hooks.settle) {
        await hooks.settle(tx, changes);
      }
      return changes;
    }).catch((error: unknown) => {
      if (error instanceof PortionsConflictRefusal) return error;
      throw error;
    });
    // Kontrakt domenowy bez 409: odmowa = `applied: false` + naruszenia.
    // Transakcja jest już wycofana w całości, więc nic nie weszło.
    if (outcome instanceof PortionsConflictRefusal) {
      return {
        applied: false,
        dryRun: false,
        violations: outcome.violations,
        changes: { created: 0, updated: 0, deleted: 0 },
        plan: null,
      };
    }
    const changes = outcome;

    // Odczyt po transakcji, tym samym kształtem, co `getByWeek` — klient i
    // broadcast dostają plan w formacie, który już znają.
    const plan = await this.getByHouseholdAndWeek(
      userId,
      householdId,
      weekStart,
    );
    if (changes.created + changes.updated + changes.deleted > 0) {
      emitLive({ topics: ['dashboard'] });
    }
    return { applied: true, dryRun: false, violations: [], changes, plan };
  }

  /** Przepisy, które WOLNO wstawić do planu tego domu: katalog albo własne, aktywne. */
  private async loadPlannableRecipes(
    householdId: string,
    recipeIds: string[],
  ): Promise<Map<string, PlannableRecipe>> {
    const unique = Array.from(new Set(recipeIds));
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.recipe.findMany({
      where: {
        id: { in: unique },
        isActive: true,
        OR: [{ isCatalog: true }, { householdId }],
      },
      select: {
        id: true,
        mealType: true,
        suitableMealTypes: true,
        allergens: true,
        dietTags: true,
        servings: true,
        nutritionKcal: true,
        nutritionProtein: true,
        nutritionCarbs: true,
        nutritionFat: true,
        ingredients: { select: { ingredientId: true } },
      },
    });
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          mealType: row.mealType,
          suitableMealTypes: row.suitableMealTypes,
          allergens: row.allergens,
          // `?? []` nie jest tu kosmetyką: mock w spec-u zwraca wiersz bez
          // relacji, a prawdziwy przepis bez składników istnieje w bazie
          // (import katalogu dopuszcza taki stan). Brak składników znaczy
          // „nic do wykluczenia", nie „wywróć zapis całego tygodnia".
          ingredientIds: (row.ingredients ?? []).map(
            (item) => item.ingredientId,
          ),
          dietTags: row.dietTags ?? [],
          perServing: nutritionPerServing(row),
        },
      ]),
    );
  }

  /**
   * Wszystkie powody, dla których tydzień NIE może wejść — naraz.
   *
   * Kolejność sprawdzeń w obrębie slotu jest od najbardziej podstawowego:
   * nie ma sensu mówić „danie nie pasuje do slotu" o przepisie, którego w
   * ogóle nie widać.
   */
  /** Alergeny per domownik — brak wiersza preferencji znaczy „brak alergenów". */
  /**
   * Skład domu do bramek planu w JEDNYM zapytaniu: identyfikatory i alergeny.
   *
   * Wykluczeń z profilu (`UserPreference.excludedIngredientIds`) bramka NIE
   * czyta od 2.10.2026: „Czego nie jem” zniknęło z iOS 23.09 (#179) i nikt
   * nie widział, co blokuje danie — odmowa bez widocznej przyczyny. Wykluczanie
   * składników żyje w filtrach przepisów na telefonie. `collectPlanViolations`
   * dalej umie sprawdzić wykluczenia (parametr), ale żadna ścieżka ich nie podaje.
   */
  private async loadHouseholdMembersForGate(householdId: string): Promise<{
    memberIds: Set<string>;
    allergensByMember: Map<string, string[]>;
    dietByMember: Map<string, DietPreferenceValue>;
  }> {
    const rows = await this.prisma.membership.findMany({
      where: { householdId },
      select: {
        userId: true,
        user: {
          select: {
            preferences: {
              select: { allergens: true, dietPreference: true },
            },
          },
        },
      },
    });
    return {
      memberIds: new Set(rows.map((row) => row.userId)),
      allergensByMember: new Map(
        rows.map((row) => [row.userId, row.user.preferences?.allergens ?? []]),
      ),
      dietByMember: new Map(
        rows.map((row) => [
          row.userId,
          row.user.preferences?.dietPreference ?? 'NONE',
        ]),
      ),
    };
  }

  /**
   * Jedzący każdej pozycji tygodnia w bazie — „kogo pozycja dokłada” dla
   * bramki diety. Puste `participants` = cały dom (dzisiejszy skład).
   */
  private async loadCurrentAudiences(
    householdId: string,
    weekStartDate: Date,
    memberIds: Set<string>,
  ): Promise<Map<string, ReadonlySet<string>>> {
    const items = await this.prisma.planItem.findMany({
      where: { weeklyPlan: { householdId, weekStart: weekStartDate } },
      select: {
        dayOfWeek: true,
        mealType: true,
        recipeId: true,
        participants: { select: { userId: true } },
      },
    });
    return new Map(
      items.map((item) => [
        `${item.dayOfWeek}|${item.mealType}|${item.recipeId}`,
        item.participants.length > 0
          ? new Set(item.participants.map((p) => p.userId))
          : memberIds,
      ]),
    );
  }

  private collectPlanViolations(
    slots: ApplyWeekSlotDto[],
    recipes: Map<string, PlannableRecipe>,
    memberIds: Set<string>,
    allergensByMember: Map<string, string[]>,
    exclusionsByMember: Map<string, string[]> = new Map(),
    diet: DietGate | null = null,
  ): PlanViolation[] {
    const violations: PlanViolation[] = [];
    const seen = new Set<string>();
    const perSlot = new Map<string, number>();
    const perMealType = new Map<string, number>();

    slots.forEach((slot, index) => {
      const at = (code: PlanViolation['code'], message: string) =>
        violations.push({
          index,
          dayOfWeek: slot.dayOfWeek,
          mealType: slot.mealType,
          recipeId: slot.recipeId,
          code,
          message,
        });

      const key = planSlotKey(slot);
      if (seen.has(key)) {
        at('PLAN_SLOT_DUPLICATE', 'Ten przepis jest już w tym slocie.');
        return;
      }
      seen.add(key);

      const recipe = recipes.get(slot.recipeId);
      if (!recipe) {
        // Nieznany, wycofany albo należący do innego gospodarstwa — z punktu
        // widzenia wołającego to jedno i to samo: nie ma czego wstawić.
        at('RECIPE_NOT_FOUND', 'Nie znaleziono przepisu.');
        return;
      }
      if (!effectiveSuitableMealTypes(recipe).includes(slot.mealType)) {
        at(
          'RECIPE_NOT_SUITABLE_FOR_SLOT',
          'Ten przepis nie nadaje się do tego posiłku.',
        );
      }

      // Alergeny są TWARDE i sprawdza je SERWER, nie model.
      //
      // Do Fazy 1 pilnowała ich wyłącznie instrukcja w promptcie, a model
      // wnioskował o składzie z listy składników — która w digeście jest
      // przycięta do pięciu najcięższych. Na katalogu dev 15 z 65 przepisów
      // z laktozą nie pokazuje w niej nabiału, więc „dorsz z masłem" wygląda
      // na czysty. Audytorium liczymy tak samo jak wszędzie: puste
      // `participantIds` znaczy cały dom.
      const audience =
        (slot.participantIds ?? []).length > 0
          ? (slot.participantIds ?? [])
          : Array.from(memberIds);
      // Reguły ze wspólnego silnika (`recipe-constraints`, N8A) — te same co
      // planer i wyszukiwarka. Dieta tylko z `diet` (zapis tygodnia, S5):
      // ręczny zapis pozycji i cofnięcie propozycji jej nie podlegają.
      const audienceAllergens = Array.from(
        new Set(
          audience.flatMap((memberId) => allergensByMember.get(memberId) ?? []),
        ),
      );
      const conflictIds = new Set(
        allergenConflicts(recipe, { allergens: audienceAllergens }),
      );
      // Kolejność w komunikacie = kolejność domowników i ich listy (jak przed
      // N8A), a nie alfabetyczna z `allergenConflicts`.
      const conflicting = audienceAllergens.filter((allergen) =>
        conflictIds.has(allergen),
      );
      if (conflicting.length > 0) {
        at(
          'RECIPE_ALLERGEN_CONFLICT',
          `Danie zawiera alergeny domownika: ${conflicting.join(', ')}.`,
        );
      }

      // Wykluczenia są równie twarde co alergeny, ale to inna rzecz i inny
      // komunikat: alergen jest o zdrowiu, wykluczenie o gustach. Wspólny
      // kod dawałby zdanie „danie zawiera alergeny: pieczarka", które po
      // prostu nie jest prawdą — a użytkownik czyta te komunikaty.
      const hit = excludedIngredientHits(recipe, {
        excludedIngredientIds: audience.flatMap(
          (memberId) => exclusionsByMember.get(memberId) ?? [],
        ),
      });
      if (hit.length > 0) {
        at(
          'RECIPE_EXCLUDED_INGREDIENT',
          'Danie zawiera składnik, którego ktoś z jedzących nie je.',
        );
      }

      // Dieta — tylko osoby, które pozycja dokłada względem bazy (`DietGate`).
      // Komunikat bez nazwy diety i osoby: idzie do modelu i do szczegółów
      // odmowy, a dieta to dane o zdrowiu.
      if (diet) {
        const before = diet.current.get(
          `${slot.dayOfWeek}|${slot.mealType}|${slot.recipeId}`,
        );
        const breaks = audience.some((memberId) => {
          if (before?.has(memberId)) return false;
          const preference = diet.dietByMember.get(memberId) ?? 'NONE';
          return (
            (diet.allDiets || WRITE_GATE_DIETS.has(preference)) &&
            !subjectSatisfiesDiet(recipe, preference)
          );
        });
        if (breaks) {
          at(
            'RECIPE_DIET_CONFLICT',
            'Danie nie pasuje do diety kogoś z jedzących.',
          );
        }
      }

      const unknownParticipants = Array.from(
        new Set(slot.participantIds ?? []),
      ).filter((id) => !memberIds.has(id));
      if (unknownParticipants.length > 0) {
        at(
          'PLAN_PARTICIPANT_NOT_IN_HOUSEHOLD',
          `Nie należą do gospodarstwa: ${unknownParticipants.join(', ')}`,
        );
      }

      // Porcje per osoba (Etap 2.2): zbiór osób = audytorium, krok 0,05,
      // widełki i suma — inaczej bilans i lista zakupów rozjechałyby się
      // z tym, kto naprawdę je.
      if ((slot.portions ?? []).length > 0) {
        const problem = portionsProblem(slot.portions ?? [], new Set(audience));
        if (problem) at('PLAN_PORTIONS_INVALID', problem);
      }

      const slotKey = `${slot.dayOfWeek}|${slot.mealType}`;
      const inSlot = (perSlot.get(slotKey) ?? 0) + 1;
      perSlot.set(slotKey, inSlot);
      if (inSlot > WeeklyPlansService.MAX_VARIANTS_PER_SLOT) {
        at(
          'PLAN_SLOT_VARIANT_LIMIT_REACHED',
          `Za dużo dań w jednym posiłku (maks. ${WeeklyPlansService.MAX_VARIANTS_PER_SLOT}).`,
        );
      }

      const inMealType = (perMealType.get(slot.mealType) ?? 0) + 1;
      perMealType.set(slot.mealType, inMealType);
      if (inMealType > WeeklyPlansService.MAX_ITEMS_PER_MEAL_TYPE) {
        at(
          'PLAN_SLOT_LIMIT_REACHED',
          `Za dużo dań w tym posiłku w tygodniu (maks. ${WeeklyPlansService.MAX_ITEMS_PER_MEAL_TYPE}).`,
        );
      }

      if (index + 1 > WeeklyPlansService.MAX_ITEMS_TOTAL) {
        at(
          'PLAN_TOTAL_LIMIT_REACHED',
          `Za dużo pozycji w tygodniu (maks. ${WeeklyPlansService.MAX_ITEMS_TOTAL}).`,
        );
      }
    });

    return violations;
  }

  /**
   * Ta sama reguła co `resolveParticipants`, ale bez zapytania do bazy —
   * lista domowników jest już wczytana raz na cały tydzień. Audytorium
   * obejmujące WSZYSTKICH zwija się do pustej listy („Wspólne"), więc obie
   * formy tego samego wyboru dają tyle samo porcji.
   */
  /**
   * Sloty stanu docelowego: klucz, audytorium znormalizowane („Wspólne” = `[]`)
   * i ZAPAMIĘTANY zbiór osób z żądania — `settleParticipants` porówna go
   * z zapisanym, zanim normalizacja zmieni samą reprezentację.
   */
  private desiredSlots(
    slots: readonly ApplyWeekSlotDto[],
    memberIds: Set<string>,
  ): DesiredSlot[] {
    return slots.map((slot) => ({
      ...slot,
      key: planSlotKey(slot),
      requestedParticipantIds: [...new Set(slot.participantIds ?? [])],
      ...this.normalizeParticipants(slot.participantIds, memberIds),
      portions: normalizedPortions(slot.portions),
    }));
  }

  private normalizeParticipants(
    requested: string[] | undefined,
    memberIds: Set<string>,
  ): { participantIds: string[] } {
    const unique = Array.from(new Set(requested ?? []));
    const everyone = unique.length === 0 || unique.length === memberIds.size;
    return { participantIds: everyone ? [] : unique };
  }

  /**
   * Policz tydzień i opisz go, ale NIE zapisuj.
   *
   * Ta sama ścieżka walidacji co zapis (`collectPlanViolations`): alergeny,
   * dopasowanie dania do posiłku i limity liczy serwer, nie model. Różnica
   * jest jedna — zamiast liczników wracają nazwy, kalorie i czasy, czyli to,
   * z czego da się złożyć kartę propozycji.
   *
   * Świadomie osobna metoda, a nie rozszerzenie `ApplyWeekPlanResult`: ten typ
   * jedzie w acku `weeklyPlans:applyWeekPlan` do każdego klienta i utuczenie go
   * o podgląd obciążyłoby wszystkich wołających.
   */
  async previewWeekPlan(
    userId: string,
    householdId: string,
    weekStart: string,
    input: ApplyWeekPlanDto,
    // `all` — dieta dla KAŻDEJ pozycji, nie tylko zmienionych. Tylko dla
    // raportu `check_plan_conflicts`, który nic nie blokuje; podgląd przed
    // zapisem musi mieć ten sam zakres co `applyWeekPlan` (`changed`).
    options: { dietScope?: 'changed' | 'all' } = {},
  ): Promise<WeekPlanPreview> {
    const dto = await validateDto(ApplyWeekPlanDto, input);
    await ensureMembership(this.prisma, userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);

    const { memberIds, allergensByMember, dietByMember } =
      await this.loadHouseholdMembersForGate(householdId);
    const recipeIds = dto.slots.map((slot) => slot.recipeId);
    const plannable = await this.loadPlannableRecipes(householdId, recipeIds);
    const currentAudiences =
      options.dietScope === 'all'
        ? new Map<string, ReadonlySet<string>>()
        : await this.loadCurrentAudiences(
            householdId,
            weekStartDate,
            memberIds,
          );

    // Ten sam walidator i TE SAME argumenty co w `applyWeekPlan` — podgląd
    // buduje kartę propozycji, a zapis kliknięciem idzie przez apply. Gdy
    // podgląd sprawdza mniej (przez tydzień nie dostawał wykluczeń), karta
    // pokazuje plan jako czysty, a „Dodaj do planu" kończy się odmową.
    const violations = this.collectPlanViolations(
      dto.slots,
      plannable,
      memberIds,
      allergensByMember,
      undefined,
      {
        dietByMember,
        current: currentAudiences,
        allDiets: options.dietScope === 'all',
      },
    );
    if (violations.length > 0) {
      return {
        violations,
        changes: { created: 0, updated: 0, deleted: 0 },
        slots: null,
        removed: null,
      };
    }

    for (const slot of dto.slots) {
      assertPortionPolicyShape(slot.portionPolicy, slot.portions);
    }
    const requested = this.desiredSlots(dto.slots, memberIds);
    // Karta nie może obiecać zapisu, który odbije się o porcje per osoba.
    // Zapis propozycji idzie jako `verified` (guard z odciskiem tygodnia),
    // więc tak samo liczy podgląd; `force` odmówi zmiany alokacji na zapisie.
    const portions = await this.advisoryPortions(
      householdId,
      weekStartDate,
      requested,
      'verified',
      memberIds,
    );
    if (portions.conflicts.length > 0) {
      return {
        violations: portions.conflicts,
        changes: { created: 0, updated: 0, deleted: 0 },
        slots: null,
        removed: null,
      };
    }
    const desired = portions.settled;
    const changes = await this.previewWeekPlanChanges(
      householdId,
      weekStartDate,
      desired,
      portions.keep,
      portions.planned,
    );

    // Opis pozycji bierzemy osobnym odczytem: `loadPlannableRecipes` celowo
    // ciągnie minimum potrzebne do walidacji, a karta potrzebuje tytułu,
    // kalorii i czasu.
    const details = await this.prisma.recipe.findMany({
      where: { id: { in: Array.from(new Set(recipeIds)) } },
      select: {
        id: true,
        title: true,
        servings: true,
        prepTimeMinutes: true,
        nutritionKcal: true,
        imageUrl: true,
      },
    });
    const detailsById = new Map(details.map((row) => [row.id, row]));

    const current = await this.prisma.planItem.findMany({
      where: {
        weeklyPlan: { householdId, weekStart: weekStartDate },
      },
      select: {
        dayOfWeek: true,
        mealType: true,
        recipeId: true,
        recipe: { select: { title: true } },
      },
    });
    const currentKeys = new Set(current.map((item) => planSlotKey(item)));
    const desiredKeys = new Set(desired.map((slot) => slot.key));

    const slots: WeekPlanPreviewSlot[] = desired.map((slot) => {
      const detail = detailsById.get(slot.recipeId);
      const servings = Math.max(1, detail?.servings ?? 1);
      // Stan EFEKTYWNY: pozycja z decyzją KEEP zostanie przy zapisie
      // nietknięta, więc karta pokazuje jej zachowaną alokację, a nie równy
      // podział z pustego pola żądania. Akcja propozycji porcji nie dostaje —
      // wiążąca decyzja zapada przy zapisie, pod zamkiem.
      const kept = portions.keep.has(slot.key)
        ? portions.currentByKey.get(slot.key)
        : undefined;
      const slotPortions = kept
        ? toPortionViews(kept.portions)
        : (portions.planned.get(slot.key) ?? slot.portions);
      return {
        dayOfWeek: slot.dayOfWeek,
        mealType: slot.mealType,
        recipeId: slot.recipeId,
        title: detail?.title ?? '',
        kcalPerServing: Math.round((detail?.nutritionKcal ?? 0) / servings),
        prepTimeMinutes: detail?.prepTimeMinutes ?? 0,
        // Karta propozycji trafia do historii rozmowy — bez adresu
        // generatora (tytuł i opis przepisu domu w ścieżce, audyt 2.2.5).
        imageUrl:
          detail?.imageUrl?.trim() &&
          !isGeneratedRecipeImageUrl(detail.imageUrl)
            ? detail.imageUrl
            : null,
        participantIds: slot.participantIds,
        ...withPortions(slotPortions),
        ...(slotPortions.length === 0
          ? {
              servingsPerPerson: servingsPerPerson(
                {
                  participantIds: slot.participantIds,
                  plannedServings: slot.plannedServings ?? null,
                },
                memberIds.size,
              ),
            }
          : {}),
        change: currentKeys.has(slot.key) ? 'KEPT' : 'NEW',
      };
    });

    const removed: WeekPlanPreviewRemoval[] = current
      .filter((item) => !desiredKeys.has(planSlotKey(item)))
      .map((item) => ({
        dayOfWeek: item.dayOfWeek,
        mealType: item.mealType,
        recipeId: item.recipeId,
        title: item.recipe.title,
      }));

    return { violations: [], changes, slots, removed };
  }

  /**
   * Tydzień z bazy w kształcie WEJŚCIA `applyWeekPlan`.
   *
   * To jest materiał na „Cofnij”: operacja stanu docelowego jest swoją własną
   * odwrotnością, więc cofnięcie zapisu to ponowne zastosowanie tego, co było
   * przed nim — bez liczenia odwrotnego diffa i bez drugiej ścieżki zapisu.
   *
   * `tx` = odczyt W transakcji zapisu (hak `settle` z `applyWeekPlan`), czyli
   * tydzień, który właśnie zatwierdzamy, a nie ostatni zatwierdzony. Bramkę
   * członkostwa ta transakcja przeszła już pod zamkiem tygodnia
   * (`ensureMembershipInTx`), więc tu jej nie powtarzamy — odczyt poza
   * transakcją widziałby skład domu z innej chwili.
   */
  async snapshotWeekAsSlots(
    userId: string,
    householdId: string,
    weekStart: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ApplyWeekSlotDto[]> {
    if (!tx) await ensureMembership(this.prisma, userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);
    const client = tx ?? this.prisma;

    const items = await client.planItem.findMany({
      where: { weeklyPlan: { householdId, weekStart: weekStartDate } },
      select: {
        dayOfWeek: true,
        mealType: true,
        recipeId: true,
        plannedServings: true,
        participants: { select: { userId: true } },
        portions: { select: { userId: true, units: true } },
      },
      orderBy: [{ mealType: 'asc' }, { createdAt: 'asc' }],
    });

    return items.map((item) => ({
      dayOfWeek: item.dayOfWeek,
      mealType: item.mealType,
      recipeId: item.recipeId,
      participantIds: item.participants.map(
        (participant) => participant.userId,
      ),
      plannedServings: item.plannedServings,
      // Porcje per osoba przeżywają migawkę: „Cofnij", baseline propozycji
      // i planer widzą je tak samo, jak zapis (Etap 2.2).
      ...withPortions(toPortionViews(item.portions)),
    }));
  }

  /**
   * Decyzja porcji per osoba (`portionsWriteDecision`) dla każdego slotu,
   * który trafia w istniejącą pozycję: naruszenia `PLAN_PORTIONS_CONFLICT`
   * i klucze pozycji, które mają zostać nietknięte.
   *
   * USUNIĘCIE pozycji z alokacją, której nie ma w stanie docelowym (w tym
   * zamiana dania wyrażona jako usunięcie starego klucza i nowy klucz), liczy
   * `portionsRemovalDecision`: `strict` wymaga tokenu (`PLAN_REVISION_REQUIRED`),
   * `no-allocation-changes` odmawia (`PLAN_PORTIONS_CONFLICT`), `verified`
   * i `authoritative` usuwają (`index: -1`).
   */
  private portionsDecisions(
    desired: readonly DesiredSlot[],
    currentByKey: ReadonlyMap<
      string,
      {
        dayOfWeek: DayOfWeek;
        mealType: MealType;
        recipeId: string;
        plannedServings: number;
        participants: { userId: string }[];
        portions: { userId: string; units: number }[];
      }
    >,
    policy: PortionsWritePolicy,
    memberIds: ReadonlySet<string>,
  ): {
    conflicts: PlanViolation[];
    keep: Set<string>;
    planned: Map<string, PortionView[]>;
  } {
    const conflicts: PlanViolation[] = [];
    const keep = new Set<string>();
    const planned = new Map<string, PortionView[]>();
    desired.forEach((slot, index) => {
      const intent = portionIntentOf(slot.portionPolicy, slot.portions);
      const existing = currentByKey.get(slot.key);
      if (!existing) {
        // Nowa pozycja: alokację tworzą tylko jawne porcje.
        planned.set(slot.key, intent === 'REPLACE' ? [...slot.portions] : []);
        return;
      }
      const plan = planPortionsForExisting(
        {
          participantIds: existing.participants.map((p) => p.userId),
          plannedServings: existing.plannedServings,
          portions: toPortionViews(existing.portions),
        },
        {
          participantIds: slot.participantIds,
          plannedServings: slot.plannedServings,
          portions: slot.portions,
          intent,
          audience:
            slot.participantIds.length > 0
              ? slot.participantIds
              : [...memberIds],
        },
        policy,
      );
      planned.set(slot.key, plan.portions);
      if (plan.decision === 'KEEP') keep.add(slot.key);
      const at = {
        index,
        dayOfWeek: slot.dayOfWeek,
        mealType: slot.mealType,
        recipeId: slot.recipeId,
      };
      if (plan.decision === 'INVALID') {
        conflicts.push({
          ...at,
          code: 'PLAN_PORTIONS_INVALID',
          message: plan.problem ?? PRESERVE_SERVINGS_PROBLEM,
        });
      }
      if (
        plan.decision === 'CONFLICT' ||
        plan.decision === 'REVISION_REQUIRED'
      ) {
        conflicts.push({ ...at, ...portionsRefusal(plan.decision) });
      }
    });
    const removal = portionsRemovalDecision(policy);
    if (removal) {
      const desiredKeys = new Set(desired.map((slot) => slot.key));
      for (const [key, existing] of currentByKey) {
        if (desiredKeys.has(key) || existing.portions.length === 0) continue;
        conflicts.push({
          index: -1,
          dayOfWeek: existing.dayOfWeek,
          mealType: existing.mealType,
          recipeId: existing.recipeId,
          ...portionsRefusal(removal),
        });
      }
    }
    return { conflicts, keep, planned };
  }

  /**
   * `portionsDecisions` na odczycie bez zamka — podgląd i `dryRun` (doradczo;
   * wiążąca decyzja zapada w transakcji zapisu). Oddaje też pozycje, żeby
   * podgląd pokazał stan efektywny pozycji KEEP.
   */
  private async advisoryPortions(
    householdId: string,
    weekStartDate: Date,
    desired: readonly DesiredSlot[],
    policy: PortionsWritePolicy,
    memberIds: ReadonlySet<string>,
  ) {
    const items = await this.prisma.planItem.findMany({
      where: { weeklyPlan: { householdId, weekStart: weekStartDate } },
      select: {
        dayOfWeek: true,
        mealType: true,
        recipeId: true,
        plannedServings: true,
        participants: { select: { userId: true } },
        portions: { select: { userId: true, units: true } },
      },
    });
    const currentByKey = new Map(
      items.map((item) => [planSlotKey(item), item]),
    );
    const settled = settleParticipants(desired, currentByKey);
    return {
      ...this.portionsDecisions(settled, currentByKey, policy, memberIds),
      currentByKey,
      settled,
    };
  }

  /**
   * Ile by się zmieniło, gdyby zapisać — bez zapisywania (`dryRun`).
   * `keep` = pozycje, które zapis zostawi nietknięte (decyzja porcji KEEP) —
   * nie liczą się jako zmiana, tak jak w zapisie.
   */
  private async previewWeekPlanChanges(
    householdId: string,
    weekStartDate: Date,
    desired: {
      key: string;
      participantIds: string[];
      plannedServings?: number;
      portions: PortionView[];
    }[],
    keep: ReadonlySet<string>,
    planned: ReadonlyMap<string, PortionView[]>,
  ): Promise<{ created: number; updated: number; deleted: number }> {
    const plan = await this.prisma.weeklyPlan.findUnique({
      where: {
        householdId_weekStart: { householdId, weekStart: weekStartDate },
      },
      select: { id: true },
    });
    if (!plan) {
      return { created: desired.length, updated: 0, deleted: 0 };
    }
    const [current, memberCount] = await Promise.all([
      this.prisma.planItem.findMany({
        where: { weeklyPlanId: plan.id },
        select: {
          dayOfWeek: true,
          mealType: true,
          recipeId: true,
          plannedServings: true,
          participants: { select: { userId: true } },
          portions: { select: { userId: true, units: true } },
        },
      }),
      this.prisma.membership.count({ where: { householdId } }),
    ]);
    const currentByKey = new Map(
      current.map((item) => [planSlotKey(item), item]),
    );
    const desiredKeys = new Set(desired.map((slot) => slot.key));

    let created = 0;
    let updated = 0;
    for (const slot of desired) {
      const existing = currentByKey.get(slot.key);
      if (!existing) {
        created += 1;
        continue;
      }
      if (keep.has(slot.key)) continue;
      const currentParticipantIds = existing.participants.map((p) => p.userId);
      const participantsChanged = !sameIdSet(
        currentParticipantIds,
        slot.participantIds,
      );
      // Ta sama reguła porcji, co przy zapisie — inaczej karta propozycji
      // obiecywała inną liczbę zmian niż potem wykonał zapis.
      const finalPortions = planned.get(slot.key) ?? slot.portions;
      const plannedServings =
        finalPortions.length > 0
          ? derivedPlannedServings(finalPortions)
          : this.resolveUpdatedPlannedServings({
              currentPlannedServings: existing.plannedServings,
              currentParticipantIds,
              nextParticipantIds: slot.participantIds,
              memberCount,
              requested: slot.plannedServings,
            });
      const servingsChanged =
        plannedServings !== existing.plannedServings ||
        !samePortions(toPortionViews(existing.portions), finalPortions);
      if (participantsChanged || servingsChanged) updated += 1;
    }

    return {
      created,
      updated,
      deleted: current.filter((item) => !desiredKeys.has(planSlotKey(item)))
        .length,
    };
  }

  async removeWeekSlot(
    userId: string,
    householdId: string,
    weekStart: string,
    input: RemoveWeekSlotDto,
  ) {
    const dto = await validateDto(RemoveWeekSlotDto, input);
    await ensureMembership(this.prisma, userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);

    return this.prisma.$transaction(async (tx) => {
      const weeklyPlan = await tx.weeklyPlan.findUnique({
        where: {
          householdId_weekStart: {
            householdId,
            weekStart: weekStartDate,
          },
        },
        select: { id: true },
      });
      // Zamek przed stanem archiwum — kolejność jak w `upsertWeekSlot`.
      // Tygodnia bez wiersza nie ma czym zamknąć i nie trzeba: stan archiwum
      // jest wtedy jedyną blokadą tej transakcji.
      if (weeklyPlan) {
        await lockWeekForWrite(tx, weeklyPlan.id);
      }
      await ensureMembershipInTx(tx, userId, householdId);

      await tx.shoppingListArchiveState.deleteMany({
        where: {
          householdId,
          weekStart: weekStartDate,
          currentArchiveId: null,
        },
      });

      if (!weeklyPlan) {
        return null;
      }

      // With splits a slot can hold several variants. `recipeId` targets one
      // of them; omitting it clears the whole slot, which is what every
      // pre-split caller means by this message.
      const doomed = await tx.planItem.findMany({
        where: {
          weeklyPlanId: weeklyPlan.id,
          dayOfWeek: dto.dayOfWeek,
          mealType: dto.mealType,
          ...(dto.recipeId ? { recipeId: dto.recipeId } : {}),
        },
        select: { id: true },
      });

      if (doomed.length === 0) {
        return null;
      }

      const { count } = await tx.planItem.deleteMany({
        where: { id: { in: doomed.map((item) => item.id) } },
      });

      if (count === 0) {
        return null;
      }
      await bumpWeekRevision(tx, weeklyPlan.id);

      await this.shoppingListService.markShoppingListStale(
        householdId,
        weekStartDate,
        tx,
      );

      return { removedItemIds: doomed.map((item) => item.id), count };
    });
  }

  /**
   * Porcja JEDNEJ osoby w pozycji z alokacją (`weeklyPlans:setPortion`,
   * ADR `plan-portions-safe-editing`, decyzja 2).
   *
   * Zapisuje wyłącznie wiersz tej osoby (i pochodne `plannedServings`), więc
   * edycje porcji RÓŻNYCH osób z tego samego odczytu nie kolidują. Nadpisanie
   * tej samej osoby chroni stempel jej porcji (`expectedRevision`). Wszystko
   * pod zamkiem tygodnia — współbieżne przekroczenie sumy widzi porcję
   * pierwszego zapisu.
   */
  async setPortion(
    userId: string,
    householdId: string,
    weekStart: string,
    input: SetPortionDto,
  ) {
    const dto = await validateDto(SetPortionDto, input);
    await ensureMembership(this.prisma, userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);

    return this.prisma.$transaction(async (tx) => {
      const weeklyPlan = await tx.weeklyPlan.findUnique({
        where: {
          householdId_weekStart: { householdId, weekStart: weekStartDate },
        },
        select: { id: true },
      });
      if (!weeklyPlan) throw planItemNotFound();
      await lockWeekForWrite(tx, weeklyPlan.id);
      await ensureMembershipInTx(tx, userId, householdId);

      // Pozycja szukana WYŁĄCZNIE w tym tygodniu tego domu: cudza pozycja
      // wygląda jak nieistniejąca (bez wyroczni istnienia).
      const item = await tx.planItem.findFirst({
        where: { id: dto.planItemId, weeklyPlanId: weeklyPlan.id },
        select: {
          id: true,
          portions: { select: { userId: true, units: true, revision: true } },
        },
      });
      if (!item) throw planItemNotFound();
      if (item.portions.length === 0) {
        throw portionsConflict(item.id, 'NOT_ALLOCATED');
      }
      const mine = item.portions.find((row) => row.userId === dto.userId);
      if (!mine) throw portionsConflict(item.id, 'NOT_IN_AUDIENCE');

      const unchanged = async () => {
        const current = await tx.planItem.findUniqueOrThrow({
          where: { id: item.id },
          include: PLAN_ITEM_INCLUDE,
        });
        return {
          ...withPlanItemRelationIds(current),
          changeKind: 'NOOP' as const,
        };
      };
      const requestedUnits = servingsToUnits(dto.servings);
      if (mine.revision !== dto.expectedRevision) {
        // Ponowienie po utraconej odpowiedzi: stan już jest żądanym.
        if (requestedUnits === mine.units) return unchanged();
        throw revisionConflict({ id: item.id, revision: mine.revision });
      }
      if (requestedUnits === mine.units) return unchanged();

      const next = toPortionViews(item.portions).map((portion) =>
        portion.userId === dto.userId
          ? { userId: portion.userId, servings: dto.servings }
          : portion,
      );
      const problem = portionsProblem(
        next,
        new Set(item.portions.map((row) => row.userId)),
      );
      if (problem || requestedUnits === null) {
        throw new AppException(
          'PLAN_PORTIONS_INVALID',
          problem ?? 'Nieprawidłowa porcja.',
          HttpStatus.BAD_REQUEST,
        );
      }

      // Kolejność blokad jak w `upsertWeekSlot`: stan archiwum przed
      // pozycjami i listą zakupów.
      await tx.shoppingListArchiveState.deleteMany({
        where: {
          householdId,
          weekStart: weekStartDate,
          currentArchiveId: null,
        },
      });
      const revision = await bumpWeekRevision(tx, weeklyPlan.id);
      await tx.planItemPortion.update({
        where: {
          planItemId_userId: { planItemId: item.id, userId: dto.userId },
        },
        data: { units: requestedUnits, revision },
      });
      const updated = await tx.planItem.update({
        where: { id: item.id },
        data: { plannedServings: derivedPlannedServings(next), revision },
        include: PLAN_ITEM_INCLUDE,
      });
      await this.shoppingListService.markShoppingListStale(
        householdId,
        weekStartDate,
        tx,
      );
      return {
        ...withPlanItemRelationIds(updated),
        changeKind: 'DETAILS_CHANGED' as const,
      };
    });
  }

  /**
   * Marks one planned meal as eaten by the caller, or clears that mark.
   *
   * The mark is per-user (`PlanItemConsumption`), so two members sharing a
   * dinner each log it for themselves. Idempotent in both directions: marking
   * an already-eaten meal is a no-op, and unmarking one that was never marked
   * quietly returns the item unchanged — a double-tap from a flaky connection
   * must not become an error the app has to explain.
   */
  async setMealEaten(
    userId: string,
    householdId: string,
    weekStart: string,
    input: SetMealEatenDto,
    /**
     * W transakcji odhaczenia, po nim (asystent: dziennik efektów tury,
     * workstream Etap 5, Addendum A1). Domena nie wie, kto go podaje.
     */
    options: {
      inTransaction?: (
        tx: Prisma.TransactionClient,
        planItemId: string,
      ) => Promise<void>;
    } = {},
  ) {
    const dto = await validateDto(SetMealEatenDto, input);
    await ensureMembership(this.prisma, userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);

    const weeklyPlan = await this.prisma.weeklyPlan.findUnique({
      where: {
        householdId_weekStart: { householdId, weekStart: weekStartDate },
      },
      select: { id: true },
    });

    // Brak wiersza tygodnia to z punktu widzenia klienta to samo, co brak
    // posiłku w slocie — jeden kod, żeby iOS i asystent nie musiały
    // rozróżniać dwóch odmian „nie ma czego odhaczyć".
    if (!weeklyPlan) {
      throw new AppException(
        'PLAN_ITEM_NOT_FOUND',
        'Tego posiłku nie ma w planie tego tygodnia',
        HttpStatus.NOT_FOUND,
      );
    }

    const planItem = await this.prisma.planItem.findFirst({
      where: {
        weeklyPlanId: weeklyPlan.id,
        dayOfWeek: dto.dayOfWeek,
        mealType: dto.mealType,
        recipeId: dto.recipeId,
      },
      select: { id: true },
    });

    if (!planItem) {
      throw new AppException(
        'PLAN_ITEM_NOT_FOUND',
        'Tego posiłku nie ma w tym slocie',
        HttpStatus.NOT_FOUND,
      );
    }

    const write = async (client: Prisma.TransactionClient) => {
      if (dto.isEaten === true) {
        await client.planItemConsumption.upsert({
          where: {
            planItemId_userId: { planItemId: planItem.id, userId },
          },
          update: {},
          create: { planItemId: planItem.id, userId },
        });
      } else {
        await client.planItemConsumption.deleteMany({
          where: { planItemId: planItem.id, userId },
        });
      }
    };
    const { inTransaction } = options;
    if (inTransaction) {
      await this.prisma.$transaction(async (tx) => {
        await write(tx);
        await inTransaction(tx, planItem.id);
      });
    } else {
      await write(this.prisma);
    }

    const updated = await this.prisma.planItem.findUniqueOrThrow({
      where: { id: planItem.id },
      include: PLAN_ITEM_INCLUDE,
    });

    return withPlanItemRelationIds(updated);
  }

  /**
   * „Zjedzone” po gotowaniu w trybie Gotuj (docs iOS Gotuj D21, D56).
   *
   * Wszystko według tego, co gotujący WIDZI w Kalendarzu i bilansie
   * (`visibleToMember`: własne danie w porze wygrywa ze wspólnym, cudzych
   * imiennych nie widzi) — odhaczenie pozycji, której nie widać, nie
   * zostawiłoby śladu ani w planie, ani w kcal.
   *
   * 1. Przepis stoi DZIŚ w planie i gotujący go widzi (najpierw w porze
   *    z żądania) — odhaczamy go tam, jak `setMealEaten`. Tak kończy się też
   *    ponowienie po utraconej odpowiedzi.
   * 2. Stoi, ale tylko dla innych — gotujący dochodzi do audytorium tej
   *    pozycji (ta sama „suma audytoriów”, co ręczne dodanie przepisu dla
   *    drugiej osoby; porcje osób zostają, `PRESERVE`) i jest odhaczony —
   *    w JEDNEJ transakcji (`cookLog.join`).
   * 3. Nie stoi — dopisujemy OBOK tego, co jest w porze (D56: nigdy nie
   *    zastępujemy, plan jest wspólny) i odhaczamy gotującego w JEDNEJ
   *    transakcji. Pozycja ma `cookedOffPlan`, więc lista zakupów jej nie
   *    liczy. Audytorium: „Wspólne”, gdy porcji co najmniej tyle, ilu
   *    domowników, a gotujący nie ma w tej porze własnego dania (inaczej
   *    nie zobaczyłby wspólnego); w pozostałych przypadkach sam gotujący. Porcje z reguły auto
   *    (1 na osobę): bilans liczy zjedzone, nie ugotowane. Alergen
   *    domownika przy „Wspólne” = wpis tylko dla gotującego; alergen samego
   *    gotującego = odmowa bramki, jak przy każdym zapisie planu.
   *
   * Bramki, limity slotów i zamek tygodnia — te same co `upsertWeekSlot`
   * (przez niego idzie zapis).
   */
  async logCookedMeal(
    userId: string,
    householdId: string,
    weekStart: string,
    input: LogCookedMealDto,
  ) {
    const validated = await validateDto(LogCookedMealDto, input);
    // iOS wysyła UUID wielkimi literami, baza oddaje małymi — porównania
    // niżej idą w JS (`===`), nie w zapytaniu.
    const dto = { ...validated, recipeId: validated.recipeId.toLowerCase() };
    await ensureMembership(this.prisma, userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);
    await ensureRecipeForHousehold(this.prisma, dto.recipeId, householdId);

    const dayItems = await this.prisma.planItem.findMany({
      where: {
        weeklyPlan: { householdId, weekStart: weekStartDate },
        dayOfWeek: dto.dayOfWeek,
      },
      select: {
        mealType: true,
        recipeId: true,
        revision: true,
        participants: { select: { userId: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const items = dayItems.map((item) => ({
      mealType: item.mealType,
      recipeId: item.recipeId,
      revision: item.revision,
      participantIds: item.participants.map((p) => p.userId),
    }));
    const inSlot = (mealType: MealType) =>
      items.filter((item) => item.mealType === mealType);
    // Pora z żądania pierwsza, potem kolejność dnia.
    const slotOrder = [
      dto.mealType,
      ...MEAL_TYPES_IN_DAY_ORDER.filter((type) => type !== dto.mealType),
    ];
    const eat = (mealType: MealType) =>
      this.setMealEaten(userId, householdId, weekStart, {
        dayOfWeek: dto.dayOfWeek,
        mealType,
        recipeId: dto.recipeId,
        isEaten: true,
      }).then((item) => ({ ...item, changeKind: 'NOOP' as const }));
    // Pozycja zniknęła między odczytem a zapisem — piszemy dalej, jakby jej
    // nie było, zamiast oddawać gotującemu 404.
    const gone = (error: unknown) =>
      error instanceof AppException && error.code === 'PLAN_ITEM_NOT_FOUND';

    for (const mealType of slotOrder) {
      const visible = visibleToMember(inSlot(mealType), userId);
      if (!visible.some((item) => item.recipeId === dto.recipeId)) continue;
      try {
        return await eat(mealType);
      } catch (error) {
        if (!gone(error)) throw error;
      }
    }

    const markEaten = async (
      tx: Prisma.TransactionClient,
      planItemId: string,
    ) => {
      await tx.planItemConsumption.upsert({
        where: { planItemId_userId: { planItemId, userId } },
        update: {},
        create: { planItemId, userId },
      });
    };

    const forOthers = slotOrder
      .flatMap((mealType) => inSlot(mealType))
      .find((item) => item.recipeId === dto.recipeId);
    if (forOthers && forOthers.participantIds.length > 0) {
      // Imienna pozycja innych — gotujący DOCHODZI do audytorium (suma
      // audytoriów jak przy ręcznym dodaniu osoby; porcje osób `PRESERVE`,
      // token z odczytu — pozycja z alokacją bez niego odmawia) i jest
      // odhaczony w tej samej transakcji. Nieaktualny token = konflikt.
      return this.upsertWeekSlot(
        userId,
        householdId,
        weekStart,
        {
          dayOfWeek: dto.dayOfWeek,
          mealType: forOthers.mealType,
          recipeId: dto.recipeId,
          participantIds: [...forOthers.participantIds, userId],
          portionPolicy: 'PRESERVE',
          expectedRevision: forOthers.revision,
        },
        { markEaten, join: true },
      );
    }
    if (forOthers) {
      // „Wspólne”, które gotującemu zasłania jego własne danie w tej porze
      // (`visibleToMember`). Uczynić je widocznym dałoby się tylko,
      // zawężając audytorium innym, a drugiej pozycji z tym przepisem
      // w porze być nie może — odhaczamy więc tę: zapis jest, choć Kalendarz
      // gotującego pokazuje jego własne danie. Rzadkie, świadome.
      try {
        return await eat(forOthers.mealType);
      } catch (error) {
        if (!gone(error)) throw error;
      }
    }

    const memberCount = (await this.loadMemberIds(householdId)).size;
    const cookLog = { markEaten };
    const write = (participantIds: string[]) =>
      this.upsertWeekSlot(
        userId,
        householdId,
        weekStart,
        {
          dayOfWeek: dto.dayOfWeek,
          mealType: dto.mealType,
          recipeId: dto.recipeId,
          participantIds,
        },
        cookLog,
      );
    const hasOwnInSlot = inSlot(dto.mealType).some((item) =>
      item.participantIds.includes(userId),
    );
    if (dto.servings < memberCount || hasOwnInSlot) return write([userId]);
    try {
      return await write([]);
    } catch (error) {
      if (
        error instanceof AppException &&
        error.code === 'RECIPE_ALLERGEN_CONFLICT'
      ) {
        return write([userId]);
      }
      throw error;
    }
  }

  /**
   * Narrows a requested audience down to real household members.
   *
   * An empty result means „Wspólne" — the meal is for the whole household.
   * Naming every member says exactly the same thing, so it collapses to empty
   * and the app keeps showing a single house badge instead of N avatars.
   *
   * Zwraca też liczbę domowników, bo dokładnie tego potrzebuje
   * `resolvePlannedServings` dla „Wspólnego" — a stan członkostwa i tak jest
   * tu odpytany, więc oddanie go wołającemu oszczędza drugi round-trip.
   */
  /**
   * Żywy skład domu jako zbiór identyfikatorów. Osobno od
   * `resolveParticipants`, bo ta na gałęzi „Wspólne" celowo woła tylko `count`
   * — a podmiana dania potrzebuje samych identyfikatorów, żeby odsiać duchy z
   * przejmowanego audytorium.
   */
  private async loadMemberIds(householdId: string): Promise<Set<string>> {
    const memberships = await this.prisma.membership.findMany({
      where: { householdId },
      select: { userId: true },
    });
    return new Set(memberships.map((m) => m.userId));
  }

  private async resolveParticipants(
    householdId: string,
    requested?: string[],
    /** Skład już wczytany przez wołającego — oszczędza zapytanie. */
    knownMemberIds?: Set<string>,
  ): Promise<{ participantIds: string[]; memberCount: number }> {
    const unique = Array.from(new Set(requested ?? []));
    if (unique.length === 0) {
      if (knownMemberIds) {
        return { participantIds: [], memberCount: knownMemberIds.size };
      }
      // Sama lista uczestników nie jest tu potrzebna — nie ma czego walidować
      // — ale „Wspólne" znaczy „tyle porcji, ilu domowników", więc bez tego
      // licznika auto-reguła nie miałaby z czego liczyć. `count` zamiast
      // `findMany`, bo identyfikatory na tej gałęzi i tak by przepadły.
      const memberCount = await this.prisma.membership.count({
        where: { householdId },
      });
      return { participantIds: [], memberCount };
    }

    const memberIds =
      knownMemberIds ??
      new Set(
        (
          await this.prisma.membership.findMany({
            where: { householdId },
            select: { userId: true },
          })
        ).map((m) => m.userId),
      );

    const unknown = unique.filter((id) => !memberIds.has(id));
    if (unknown.length > 0) {
      throw new AppException(
        'PLAN_PARTICIPANT_NOT_IN_HOUSEHOLD',
        `Not a household member: ${unknown.join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    return {
      participantIds: unique.length === memberIds.size ? [] : unique,
      memberCount: memberIds.size,
    };
  }

  /**
   * Ile porcji przepisu ugotować w slocie. Liczba łączna, nie „na osobę".
   *
   * Pominięte pole znaczy „policz sam", i to właśnie dzięki temu starszy
   * klient — który o porcjach nie wie nic — dostaje sensowną wartość zamiast
   * twardej jedynki z `@default` w schemacie.
   */
  private resolvePlannedServings(
    participantIds: string[],
    memberCount: number,
    requested?: number | null,
  ): number {
    // Klamra jako druga linia obrony. Od Fazy 0 `@Min(1)`/`@Max(12)` z DTO
    // odpalają się także na WS (`validateDto` na wejściu `upsertWeekSlot`),
    // więc 0 albo 999 kończy się VALIDATION_ERROR zanim tu dotrze. Przycięcie
    // zostaje dla ścieżek, które ominęłyby DTO — bez niego jedna luka w
    // walidacji zamieniałaby się w listę zakupów na 999 porcji.
    if (requested != null && Number.isFinite(requested)) {
      return clampPlannedServings(requested);
    }
    return autoPlannedServings(participantIds.length, memberCount);
  }

  /**
   * Ile porcji zostawić na ISTNIEJĄCYM itemie, gdy przychodzi kolejny upsert.
   *
   * Samo „pominięte = przelicz z audytorium" nie wystarcza, bo chipy audytorium
   * i stepper porcji siedzą w tym samym arkuszu, a klient wysyła
   * `plannedServings` tylko wtedy, gdy użytkownik ruszył stepper. Przy takiej
   * regule każde tapnięcie w chip cofałoby świadome „gotuję 4 porcje" do
   * wartości auto — a `PlanSlotPickerSheet` robi upsert przy każdej zmianie
   * audytorium, więc kasowanie byłoby codzienne, nie teoretyczne.
   *
   * Samo „pominięte = zostaw, co było" też nie wystarcza: przełączenie
   * „Wspólne → tylko ja" zostawiłoby porcje dla dwojga, choć nikt ich nie
   * wybierał i lista zakupów kupowałaby podwójnie.
   *
   * Rozstrzyga więc porównanie ze STARYM auto — policzonym z audytorium, które
   * item ma w tej chwili w bazie. Zapisana wartość równa staremu auto znaczy
   * „nikt tego nie nadpisywał", więc przeliczamy na nowe auto. Różna znaczy
   * „to wybór użytkownika" i zostaje nietknięta.
   *
   * Granicę tego rozpoznania znamy i akceptujemy: ręcznie wybrana liczba, która
   * przypadkiem równa się starej regule auto, przy zmianie audytorium przeliczy
   * się razem z nią. Alternatywą byłaby osobna kolumna „ruszane ręcznie", a tej
   * nie chcemy dokładać do modelu dla jednego przypadku brzegowego.
   */
  private resolveUpdatedPlannedServings(params: {
    currentPlannedServings: number;
    currentParticipantIds: string[];
    nextParticipantIds: string[];
    memberCount: number;
    requested?: number | null;
  }): number {
    const {
      currentPlannedServings,
      currentParticipantIds,
      nextParticipantIds,
      memberCount,
      requested,
    } = params;

    if (requested != null && Number.isFinite(requested)) {
      return this.resolvePlannedServings(
        nextParticipantIds,
        memberCount,
        requested,
      );
    }

    // Audytorium bez zmian = nie ma z czego przeliczać. Ta gałąź jest po to,
    // żeby upsert niosący wyłącznie inne pole (albo powtórzony przez retry
    // ACK-a) nie ruszał liczby porcji: bez niej zapisana wartość równa starej
    // regule auto przechodziła przez porównanie niżej i była „przeliczana"
    // na samą siebie tylko dopóty, dopóki reguła dawała ten sam wynik —
    // wystarczyło, że w gospodarstwie przybył domownik, i świadome „gotuję
    // dwie porcje" cicho stawało się trzema.
    if (sameMemberSet(currentParticipantIds, nextParticipantIds)) {
      return currentPlannedServings;
    }

    const previousAuto = this.resolvePlannedServings(
      currentParticipantIds,
      memberCount,
    );
    if (currentPlannedServings !== previousAuto) {
      return currentPlannedServings;
    }

    return this.resolvePlannedServings(nextParticipantIds, memberCount);
  }

  async clearWeekPlan(userId: string, householdId: string, weekStart: string) {
    await ensureMembership(this.prisma, userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);

    await runSerializable(this.prisma, async (tx) => {
      const weeklyPlan = await tx.weeklyPlan.findUnique({
        where: {
          householdId_weekStart: {
            householdId,
            weekStart: weekStartDate,
          },
        },
        select: { id: true },
      });

      if (weeklyPlan) {
        await lockWeekForWrite(tx, weeklyPlan.id);
      }
      await ensureMembershipInTx(tx, userId, householdId);

      // Stan archiwum zaraz po zamku, PRZED pozycjami i listą zakupów — w tej
      // kolejności biorą je zapisy posiłków. Dawniej szedł niżej, po liście:
      // zapis trzymał stan archiwum i czekał na tydzień albo listę, a
      // czyszczenie trzymało tydzień albo listę i czekało na stan archiwum.
      // Postgres kończył to `40P01 deadlock detected`, którego Prisma NIE
      // zamienia na P2034 — `runSerializable` tego nie ponawiał i wychodziło 500.
      await tx.shoppingListArchiveState.deleteMany({
        where: {
          householdId,
          weekStart: weekStartDate,
        },
      });

      if (weeklyPlan) {
        const { count } = await tx.planItem.deleteMany({
          where: { weeklyPlanId: weeklyPlan.id },
        });
        if (count > 0) await bumpWeekRevision(tx, weeklyPlan.id);
      }

      await tx.shoppingItemCheck.deleteMany({
        where: {
          householdId,
          weekStart: weekStartDate,
        },
      });

      await tx.shoppingList.deleteMany({
        where: {
          householdId,
          weekStart: weekStartDate,
        },
      });

      await tx.shoppingListArchive.deleteMany({
        where: {
          householdId,
          weekStart: weekStartDate,
        },
      });
    });

    return { success: true };
  }

  async getUserDisplayName(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { displayName: true },
    });
    return user?.displayName ?? null;
  }
}

/** Porcje z DTO jako widok (pusta lista = bez alokacji). */
function normalizedPortions(
  portions: readonly { userId: string; servings: number }[] | undefined,
): PortionView[] {
  return (portions ?? []).map((portion) => ({
    userId: portion.userId,
    servings: portion.servings,
  }));
}

/** `portions` do slotu tylko wtedy, gdy są — stary kształt zostaje bez klucza. */
function withPortions(portions: PortionView[]): { portions?: PortionView[] } {
  return portions.length > 0 ? { portions } : {};
}

/**
 * Odmowa zapisu, który skasowałby alokację pozycji niejawnie; `reason` —
 * `setPortion` na pozycji bez alokacji albo dla osoby spoza niej.
 */
function portionsConflict(
  planItemId: string,
  reason?: 'NOT_ALLOCATED' | 'NOT_IN_AUDIENCE',
): AppException {
  return new AppException(
    'PLAN_PORTIONS_CONFLICT',
    PORTIONS_CONFLICT_MESSAGE,
    HttpStatus.CONFLICT,
    [`planItemId:${planItemId}`, ...(reason ? [`reason:${reason}`] : [])],
  );
}

/**
 * Nieaktualny token pozycji (`upsertWeekSlot`) albo porcji (`setPortion`).
 * `details` niesie bieżący stempel — klient i tak odświeża plan, ale log
 * pokazuje, o ile się rozjechał. Brak pozycji = bez szczegółów.
 */
function revisionConflict(
  item: { id: string; revision: number } | null,
): AppException {
  return new AppException(
    'PLAN_REVISION_CONFLICT',
    REVISION_CONFLICT_MESSAGE,
    HttpStatus.CONFLICT,
    item ? [`planItemId:${item.id}`, `currentRevision:${item.revision}`] : [],
  );
}

/**
 * Tokeny zamiany dania idą PARAMI: token źródła sam nie chroni celu (przepisu,
 * który już leży w slocie), a token celu bez źródła nie chroni źródła. Zamiana
 * bez żadnego tokenu — kontrakt legacy. `expectedTargetRevision` bez zamiany
 * nie ma czego dotyczyć.
 */
function assertReplaceTokens(
  dto: UpsertWeekSlotDto,
  replaceRecipeId: string | null,
): void {
  const target = dto.expectedTargetRevision !== undefined;
  if (!replaceRecipeId) {
    if (target) {
      throw new AppException(
        'VALIDATION_ERROR',
        'expectedTargetRevision dotyczy wyłącznie zamiany dania (replaceRecipeId)',
        HttpStatus.BAD_REQUEST,
        ['expectedTargetRevision'],
      );
    }
    return;
  }
  const source = dto.expectedRevision !== undefined;
  if (source !== target) {
    throw new AppException(
      'PLAN_REVISION_REQUIRED',
      'Zamiana dania z tokenem wymaga tokenów źródła i celu (expectedRevision i expectedTargetRevision; null = celu nie ma).',
      HttpStatus.PRECONDITION_REQUIRED,
      [source ? 'missing:expectedTargetRevision' : 'missing:expectedRevision'],
    );
  }
}

/**
 * Kształt jawnej intencji: `REPLACE` bez porcji albo `PRESERVE`/`RESET` z
 * porcjami to sprzeczne polecenie — odmowa, zanim cokolwiek się zapisze.
 */
function assertPortionPolicyShape(
  policy: PortionPolicy | undefined,
  portions: readonly unknown[] | undefined,
): void {
  const given = (portions ?? []).length > 0;
  if (policy === 'REPLACE' && !given) {
    throw new AppException(
      'VALIDATION_ERROR',
      'portionPolicy REPLACE wymaga niepustych portions',
      HttpStatus.BAD_REQUEST,
      ['portions'],
    );
  }
  if ((policy === 'PRESERVE' || policy === 'RESET') && given) {
    throw new AppException(
      'VALIDATION_ERROR',
      `portionPolicy ${policy} wyklucza portions — porcje liczy serwer`,
      HttpStatus.BAD_REQUEST,
      ['portions'],
    );
  }
}

function portionsInvalid(problem: string): AppException {
  return new AppException(
    'PLAN_PORTIONS_INVALID',
    problem,
    HttpStatus.BAD_REQUEST,
  );
}

/** Zapis zastąpiłby albo usunął porcje per osoba bez tokenu. */
function revisionRequired(planItemId: string): AppException {
  return new AppException(
    'PLAN_REVISION_REQUIRED',
    REVISION_REQUIRED_MESSAGE,
    HttpStatus.PRECONDITION_REQUIRED,
    [`planItemId:${planItemId}`],
  );
}

function planItemNotFound(): AppException {
  return new AppException(
    'PLAN_ITEM_NOT_FOUND',
    'Tego posiłku nie ma w planie tego tygodnia',
    HttpStatus.NOT_FOUND,
  );
}

/** Naruszenie `applyWeekPlan`: tydzień zmienił się od odczytu klienta. */
function weekRevisionConflict(): PlanViolation {
  return {
    index: -1,
    code: 'PLAN_REVISION_CONFLICT',
    message: REVISION_CONFLICT_MESSAGE,
  };
}

/** Kod i komunikat naruszenia dla odmowy porcji w `applyWeekPlan`. */
function portionsRefusal(decision: 'CONFLICT' | 'REVISION_REQUIRED'): {
  code: AppErrorCode;
  message: string;
} {
  return decision === 'CONFLICT'
    ? { code: 'PLAN_PORTIONS_CONFLICT', message: PORTIONS_CONFLICT_MESSAGE }
    : { code: 'PLAN_REVISION_REQUIRED', message: REVISION_REQUIRED_MESSAGE };
}

/**
 * Polityka zapisu tygodnia: zgodny `expectedRevision` podnosi `strict` do
 * `verified` (wołający widział dokładnie ten stan). Niezgodny nie dochodzi
 * tu — kończy się `PLAN_REVISION_CONFLICT` wcześniej.
 */
function effectivePolicy(
  hooksPolicy: PortionsWritePolicy | undefined,
  expectedRevision: number | undefined,
): PortionsWritePolicy {
  const policy = hooksPolicy ?? 'strict';
  return expectedRevision !== undefined && policy === 'strict'
    ? 'verified'
    : policy;
}

/** Slot stanu docelowego po `desiredSlots`. */
type DesiredSlot = {
  key: string;
  dayOfWeek: DayOfWeek;
  mealType: MealType;
  recipeId: string;
  participantIds: string[];
  requestedParticipantIds: string[];
  plannedServings?: number;
  portions: PortionView[];
  portionPolicy?: PortionPolicy;
};

/**
 * Żądany zbiór osób identyczny z zapisanym = bez zmiany audytorium, także
 * gdy zapisana jest jawna lista WSZYSTKICH domowników (np. po odejściu
 * domownika), którą normalizacja zwinęłaby do „Wspólne”. To nie jest ta sama
 * intencja: „Wspólne” obejmuje przyszłych domowników, lista — nie. Migawka
 * tygodnia powtórzona bez zmian (propozycje asystenta) zostaje więc
 * nietknięta bit w bit. Jawne `[]` przy zapisanej liście to realna zmiana.
 */
function settleParticipants<T extends DesiredSlot>(
  desired: readonly T[],
  currentByKey: ReadonlyMap<string, { participants: { userId: string }[] }>,
): T[] {
  return desired.map((slot) => {
    const existing = currentByKey.get(slot.key);
    if (!existing) return slot;
    const stored = existing.participants.map((p) => p.userId);
    const same =
      stored.length === slot.requestedParticipantIds.length &&
      slot.requestedParticipantIds.every((id) => stored.includes(id));
    return same ? { ...slot, participantIds: stored } : slot;
  });
}

/** Wiersze porcji do zapisu ze stemplem rewizji tej transakcji. */
function stampedPortionRows(
  portions: readonly PortionView[],
  revision: number,
): (ReturnType<typeof toPortionRows>[number] & { revision: number })[] {
  return toPortionRows(portions).map((row) => ({ ...row, revision }));
}

/**
 * Odmowa porcji albo nieaktualnego tokenu wykryta W transakcji
 * `applyWeekPlan` — rzucona, żeby wycofać ją całą (także przejęcie propozycji
 * w `guard`), i zamieniona poza nią na `applied: false` + naruszenia.
 */
class PortionsConflictRefusal extends Error {
  constructor(readonly violations: PlanViolation[]) {
    super('PLAN_PORTIONS_CONFLICT');
  }
}
