import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { assertUuid, isUuid } from '../common/uuid';
import { validateDto } from '../common/validate-dto';
import { PrismaService } from '../prisma/prisma.service';
import { ApplyWeekPlanDto, ApplyWeekSlotDto } from './dto/apply-week-plan.dto';
import { UpsertWeekSlotDto } from './dto/upsert-week-slot.dto';
import { RemoveWeekSlotDto } from './dto/remove-week-slot.dto';
import { SetMealEatenDto } from './dto/set-meal-eaten.dto';
import { DayOfWeek, MealType, Prisma } from '@prisma/client';
import { AppErrorCode } from '../common/app-error-code';
import {
  MEAL_TYPES_IN_DAY_ORDER,
  effectiveSuitableMealTypes,
} from '../common/meal-types';
import { formatWeekStart, parseWeekStart } from './utils/week-formatting.util';
import {
  autoPlannedServings,
  clampPlannedServings,
} from './utils/planned-servings.util';
import {
  ensureMembership,
  ensureRecipeForHousehold,
} from './utils/auth-checks.util';
import { runSerializable } from './utils/transaction-runner.util';
import { weeklyBalanceForMember } from './utils/daily-balance.util';
import { ShoppingListService } from './services/shopping-list.service';

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
} satisfies Prisma.PlanItemInclude;

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
  const { participants, consumptions, recipe, ...rest } = item;
  return {
    ...rest,
    recipe: {
      ...recipe,
      suitableMealTypes: effectiveSuitableMealTypes(recipe),
    },
    participantIds: participants.map((p) => p.userId),
    eatenByUserIds: consumptions.map((c) => c.userId),
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
};

/** Jeden powód, dla którego pozycja tygodnia nie może wejść. */
export type PlanViolation = {
  /** Pozycja w przysłanej liście `slots` — wołający wie, co poprawić. */
  index: number;
  dayOfWeek: DayOfWeek;
  mealType: MealType;
  recipeId: string;
  code: AppErrorCode;
  message: string;
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
  /** Puste = całe gospodarstwo (ta sama konwencja co w `PlanItem`). */
  participantIds: string[];
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

    let plan = await this.prisma.weeklyPlan.findUnique({ where, include });
    if (!plan) {
      plan = await this.prisma.weeklyPlan
        .create({ data: { householdId, weekStart: weekStartDate }, include })
        .catch(async (error: unknown) => {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
          ) {
            return this.prisma.weeklyPlan.findUniqueOrThrow({ where, include });
          }
          throw error;
        });
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
    await ensureRecipeForHousehold(this.prisma, dto.recipeId, householdId);
    const resolved = await this.resolveParticipants(
      householdId,
      dto.participantIds,
    );
    const participantIds = resolved.participantIds;
    // Podmiana potrzebuje IDENTYFIKATORÓW domowników, nie tylko ich liczby:
    // przejęte audytorium starego dania trzeba przeciąć z żywym składem domu,
    // bo item mógł zapamiętać byłego domownika (duch po `leave`), a taki wpis
    // nie ma prawa wejść do nowego itemu. Liczba domowników pochodzi wtedy z
    // tej samej listy, żeby obie reguły liczyły z jednego stanu.
    const memberIds = replaceRecipeId
      ? await this.loadMemberIds(householdId)
      : null;
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

    return this.prisma.$transaction(async (tx) => {
      await tx.shoppingListArchiveState.deleteMany({
        where: {
          householdId,
          weekStart: weekStartDate,
          currentArchiveId: null,
        },
      });

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
              plannedServings: true,
              participants: { select: { userId: true } },
            },
          })
        : null;
      if (replaced) {
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

      // The item is identified by its recipe, not just by the slot: a slot can
      // hold one variant per household split. Re-upserting the same recipe
      // only rewrites who it is for.
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
          plannedServings: true,
          participants: { select: { userId: true } },
        },
      });

      if (existingItem) {
        const currentParticipantIds = existingItem.participants.map(
          (p) => p.userId,
        );
        const plannedServingsForUpdate = this.resolveUpdatedPlannedServings({
          currentPlannedServings: existingItem.plannedServings,
          currentParticipantIds,
          nextParticipantIds: effectiveParticipantIds,
          memberCount,
          requested: dto.plannedServings,
        });

        await tx.planItemParticipant.deleteMany({
          where: { planItemId: existingItem.id },
        });
        const updatedItem = await tx.planItem.update({
          where: { id: existingItem.id },
          data: {
            plannedServings: plannedServingsForUpdate,
            participants: {
              create: effectiveParticipantIds.map((id) => ({ userId: id })),
            },
          },
          include: PLAN_ITEM_INCLUDE,
        });
        await this.shoppingListService.markShoppingListStale(
          householdId,
          weekStartDate,
          tx,
        );

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
          !sameMemberSet(currentParticipantIds, effectiveParticipantIds);

        return {
          ...withPlanItemRelationIds(updatedItem),
          replacedItemIds,
          changeKind: replaced
            ? ('REPLACED' as const)
            : detailsChanged
              ? ('DETAILS_CHANGED' as const)
              : ('NOOP' as const),
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
      const plannedServings = replaced
        ? this.resolveUpdatedPlannedServings({
            currentPlannedServings: replaced.plannedServings,
            currentParticipantIds: replaced.participants.map((p) => p.userId),
            nextParticipantIds: effectiveParticipantIds,
            memberCount,
            requested: dto.plannedServings,
          })
        : plannedServingsForCreate;

      const createdItem = await tx.planItem
        .create({
          data: {
            weeklyPlanId: weeklyPlan.id,
            dayOfWeek: dto.dayOfWeek,
            mealType: dto.mealType,
            recipeId: dto.recipeId,
            plannedServings,
            participants: {
              create: effectiveParticipantIds.map((id) => ({ userId: id })),
            },
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
  ): Promise<ApplyWeekPlanResult> {
    const dto = await validateDto(ApplyWeekPlanDto, input);
    await ensureMembership(this.prisma, userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);
    const dryRun = dto.dryRun === true;

    const memberIds = await this.loadMemberIds(householdId);
    const allergensByMember = await this.loadMemberAllergens(householdId);
    const recipes = await this.loadPlannableRecipes(
      householdId,
      dto.slots.map((slot) => slot.recipeId),
    );

    const violations = this.collectPlanViolations(
      dto.slots,
      recipes,
      memberIds,
      allergensByMember,
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

    const desired = dto.slots.map((slot) => ({
      ...slot,
      key: planSlotKey(slot),
      ...this.normalizeParticipants(slot.participantIds, memberIds),
    }));

    if (dryRun) {
      const changes = await this.previewWeekPlanChanges(
        householdId,
        weekStartDate,
        desired,
      );
      return { applied: false, dryRun, violations: [], changes, plan: null };
    }

    const changes = await runSerializable(this.prisma, async (tx) => {
      // Ten sam porządek, co w `upsertWeekSlot`: stan archiwum listy zakupów
      // dla tygodnia bez archiwum jest nieaktualny z chwilą zmiany planu.
      await tx.shoppingListArchiveState.deleteMany({
        where: {
          householdId,
          weekStart: weekStartDate,
          currentArchiveId: null,
        },
      });

      const weeklyPlan = await tx.weeklyPlan.upsert({
        where: {
          householdId_weekStart: { householdId, weekStart: weekStartDate },
        },
        update: {},
        create: { householdId, weekStart: weekStartDate },
        select: { id: true },
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
        },
      });
      const currentByKey = new Map(
        current.map((item) => [planSlotKey(item), item]),
      );
      const desiredKeys = new Set(desired.map((slot) => slot.key));

      const removedIds = current
        .filter((item) => !desiredKeys.has(planSlotKey(item)))
        .map((item) => item.id);
      if (removedIds.length > 0) {
        // Kaskada zabiera uczestników i znaczniki zjedzenia — dokładnie tak,
        // jak przy `removeWeekSlot`. Archiwa list zakupów zostają.
        await tx.planItem.deleteMany({ where: { id: { in: removedIds } } });
      }

      let created = 0;
      let updated = 0;
      for (const slot of desired) {
        const existing = currentByKey.get(slot.key);
        if (!existing) {
          await tx.planItem.create({
            data: {
              weeklyPlanId: weeklyPlan.id,
              dayOfWeek: slot.dayOfWeek,
              mealType: slot.mealType,
              recipeId: slot.recipeId,
              plannedServings: this.resolvePlannedServings(
                slot.participantIds,
                memberIds.size,
                slot.plannedServings,
              ),
              participants: {
                create: slot.participantIds.map((id) => ({ userId: id })),
              },
            },
          });
          created += 1;
          continue;
        }

        const currentParticipantIds = existing.participants.map(
          (p) => p.userId,
        );
        const plannedServings = this.resolveUpdatedPlannedServings({
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
        if (
          !participantsChanged &&
          plannedServings === existing.plannedServings
        ) {
          // Slot bez zmian nie jest zapisywany — inaczej „przeplanuj tydzień"
          // odświeżałoby `updatedAt` na wszystkim i psuło ewentualny audyt.
          continue;
        }

        await tx.planItem.update({
          where: { id: existing.id },
          data: {
            plannedServings,
            ...(participantsChanged
              ? {
                  participants: {
                    deleteMany: {},
                    create: slot.participantIds.map((id) => ({ userId: id })),
                  },
                }
              : {}),
          },
        });
        updated += 1;
      }

      await this.shoppingListService.markShoppingListStale(
        householdId,
        weekStartDate,
        tx,
      );

      return { created, updated, deleted: removedIds.length };
    });

    // Odczyt po transakcji, tym samym kształtem, co `getByWeek` — klient i
    // broadcast dostają plan w formacie, który już znają.
    const plan = await this.getByHouseholdAndWeek(
      userId,
      householdId,
      weekStart,
    );
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
      },
    });
    return new Map(rows.map((row) => [row.id, row]));
  }

  /**
   * Wszystkie powody, dla których tydzień NIE może wejść — naraz.
   *
   * Kolejność sprawdzeń w obrębie slotu jest od najbardziej podstawowego:
   * nie ma sensu mówić „danie nie pasuje do slotu" o przepisie, którego w
   * ogóle nie widać.
   */
  /** Alergeny per domownik — brak wiersza preferencji znaczy „brak alergenów". */
  private async loadMemberAllergens(
    householdId: string,
  ): Promise<Map<string, string[]>> {
    const rows = await this.prisma.membership.findMany({
      where: { householdId },
      select: {
        userId: true,
        user: { select: { preferences: { select: { allergens: true } } } },
      },
    });
    return new Map(
      rows.map((row) => [row.userId, row.user.preferences?.allergens ?? []]),
    );
  }

  private collectPlanViolations(
    slots: ApplyWeekSlotDto[],
    recipes: Map<string, PlannableRecipe>,
    memberIds: Set<string>,
    allergensByMember: Map<string, string[]>,
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
      const conflicting = Array.from(
        new Set(
          audience.flatMap((memberId) =>
            (allergensByMember.get(memberId) ?? []).filter((allergen) =>
              recipe?.allergens.includes(allergen),
            ),
          ),
        ),
      );
      if (conflicting.length > 0) {
        at(
          'RECIPE_ALLERGEN_CONFLICT',
          `Danie zawiera alergeny domownika: ${conflicting.join(', ')}.`,
        );
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
  ): Promise<WeekPlanPreview> {
    const dto = await validateDto(ApplyWeekPlanDto, input);
    await ensureMembership(this.prisma, userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);

    const memberIds = await this.loadMemberIds(householdId);
    const allergensByMember = await this.loadMemberAllergens(householdId);
    const recipeIds = dto.slots.map((slot) => slot.recipeId);
    const plannable = await this.loadPlannableRecipes(householdId, recipeIds);

    const violations = this.collectPlanViolations(
      dto.slots,
      plannable,
      memberIds,
      allergensByMember,
    );
    if (violations.length > 0) {
      return {
        violations,
        changes: { created: 0, updated: 0, deleted: 0 },
        slots: null,
        removed: null,
      };
    }

    const desired = dto.slots.map((slot) => ({
      ...slot,
      key: planSlotKey(slot),
      ...this.normalizeParticipants(slot.participantIds, memberIds),
    }));
    const changes = await this.previewWeekPlanChanges(
      householdId,
      weekStartDate,
      desired,
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
      return {
        dayOfWeek: slot.dayOfWeek,
        mealType: slot.mealType,
        recipeId: slot.recipeId,
        title: detail?.title ?? '',
        kcalPerServing: Math.round((detail?.nutritionKcal ?? 0) / servings),
        prepTimeMinutes: detail?.prepTimeMinutes ?? 0,
        participantIds: slot.participantIds,
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
   */
  async snapshotWeekAsSlots(
    userId: string,
    householdId: string,
    weekStart: string,
  ): Promise<ApplyWeekSlotDto[]> {
    await ensureMembership(this.prisma, userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);

    const items = await this.prisma.planItem.findMany({
      where: { weeklyPlan: { householdId, weekStart: weekStartDate } },
      select: {
        dayOfWeek: true,
        mealType: true,
        recipeId: true,
        plannedServings: true,
        participants: { select: { userId: true } },
      },
      orderBy: [{ mealType: 'asc' }, { createdAt: 'asc' }],
    });

    return items.map((item) => ({
      dayOfWeek: item.dayOfWeek,
      mealType: item.mealType,
      recipeId: item.recipeId,
      participantIds: item.participants.map((participant) => participant.userId),
      plannedServings: item.plannedServings,
    }));
  }

  /** Ile by się zmieniło, gdyby zapisać — bez zapisywania (`dryRun`). */
  private async previewWeekPlanChanges(
    householdId: string,
    weekStartDate: Date,
    desired: {
      key: string;
      participantIds: string[];
      plannedServings?: number;
    }[],
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
    const current = await this.prisma.planItem.findMany({
      where: { weeklyPlanId: plan.id },
      select: {
        dayOfWeek: true,
        mealType: true,
        recipeId: true,
        plannedServings: true,
        participants: { select: { userId: true } },
      },
    });
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
      const participantsChanged = !sameIdSet(
        existing.participants.map((p) => p.userId),
        slot.participantIds,
      );
      const servingsChanged =
        slot.plannedServings != null &&
        slot.plannedServings !== existing.plannedServings;
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
      await tx.shoppingListArchiveState.deleteMany({
        where: {
          householdId,
          weekStart: weekStartDate,
          currentArchiveId: null,
        },
      });

      const weeklyPlan = await tx.weeklyPlan.findUnique({
        where: {
          householdId_weekStart: {
            householdId,
            weekStart: weekStartDate,
          },
        },
        select: { id: true },
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

      await this.shoppingListService.markShoppingListStale(
        householdId,
        weekStartDate,
        tx,
      );

      return { removedItemIds: doomed.map((item) => item.id), count };
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

    if (dto.isEaten === true) {
      await this.prisma.planItemConsumption.upsert({
        where: {
          planItemId_userId: { planItemId: planItem.id, userId },
        },
        update: {},
        create: { planItemId: planItem.id, userId },
      });
    } else {
      await this.prisma.planItemConsumption.deleteMany({
        where: { planItemId: planItem.id, userId },
      });
    }

    const updated = await this.prisma.planItem.findUniqueOrThrow({
      where: { id: planItem.id },
      include: PLAN_ITEM_INCLUDE,
    });

    return withPlanItemRelationIds(updated);
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
  ): Promise<{ participantIds: string[]; memberCount: number }> {
    const unique = Array.from(new Set(requested ?? []));
    if (unique.length === 0) {
      // Sama lista uczestników nie jest tu potrzebna — nie ma czego walidować
      // — ale „Wspólne" znaczy „tyle porcji, ilu domowników", więc bez tego
      // licznika auto-reguła nie miałaby z czego liczyć. `count` zamiast
      // `findMany`, bo identyfikatory na tej gałęzi i tak by przepadły.
      const memberCount = await this.prisma.membership.count({
        where: { householdId },
      });
      return { participantIds: [], memberCount };
    }

    const memberships = await this.prisma.membership.findMany({
      where: { householdId },
      select: { userId: true },
    });
    const memberIds = new Set(memberships.map((m) => m.userId));

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
        await tx.planItem.deleteMany({
          where: { weeklyPlanId: weeklyPlan.id },
        });
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

      await tx.shoppingListArchiveState.deleteMany({
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
