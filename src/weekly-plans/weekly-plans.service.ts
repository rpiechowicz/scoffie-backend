import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertWeekSlotDto } from './dto/upsert-week-slot.dto';
import { RemoveWeekSlotDto } from './dto/remove-week-slot.dto';
import { SetMealEatenDto } from './dto/set-meal-eaten.dto';
import { Prisma } from '@prisma/client';
import { MEAL_TYPES_IN_DAY_ORDER } from '../common/meal-types';
import { parseWeekStart } from './utils/week-formatting.util';
import {
  autoPlannedServings,
  clampPlannedServings,
} from './utils/planned-servings.util';
import {
  ensureMembership,
  ensureRecipeForHousehold,
} from './utils/auth-checks.util';
import { runSerializable } from './utils/transaction-runner.util';
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
    },
  },
  participants: { select: { userId: true } },
  consumptions: { select: { userId: true } },
} satisfies Prisma.PlanItemInclude;

/**
 * Flattens the join rows into the flat id arrays the clients read (see
 * `PlanItemDto`). Without this the wire shape would leak the junction tables
 * as `participants: [{ userId }]` / `consumptions: [{ userId }]`.
 */
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
 * Luźny wzorzec UUID: dowolna wersja, wielkość liter bez znaczenia. Nie pilnuje
 * bitów wersji ani wariantu, bo identyfikatory katalogu są pisane ręcznie w
 * JSON-ie — wystarczy, że nie przepuści śmieci, na których Postgres wywaliłby
 * się z 500 zamiast czytelnego 400.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `replaceRecipeId` z DTO: `null`, gdy nie ma czego podmieniać.
 *
 * Równe `recipeId` też znaczy „bez podmiany" — `PlanSlotPickerSheet` wysyła
 * edytowany przepis zawsze, także gdy użytkownik ruszył tylko audytorium; bez
 * tej reguły każda taka edycja kasowałaby item, żeby zaraz założyć go na nowo
 * (i po drodze gubiła znaczniki zjedzenia).
 *
 * Walidacja siedzi tu, a nie w dekoratorach DTO, bo na ścieżce WS te nie
 * działają (patrz `resolvePlannedServings`).
 */
function parseReplaceRecipeId(
  value: unknown,
  recipeId: string,
): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new AppException(
      'VALIDATION_ERROR',
      'replaceRecipeId musi być identyfikatorem UUID',
      HttpStatus.BAD_REQUEST,
    );
  }
  return value === recipeId ? null : value;
}

function withPlanItemRelationIds<
  T extends {
    participants?: { userId: string }[];
    consumptions?: { userId: string }[];
  },
>(
  item: T,
): Omit<T, 'participants' | 'consumptions'> & {
  participantIds: string[];
  eatenByUserIds: string[];
} {
  const { participants, consumptions, ...rest } = item;
  return {
    ...rest,
    participantIds: (participants ?? []).map((p) => p.userId),
    eatenByUserIds: (consumptions ?? []).map((c) => c.userId),
  };
}

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

  async getByHouseholdAndWeek(
    userId: string,
    householdId: string,
    weekStart: string,
  ) {
    await ensureMembership(this.prisma, userId, householdId);
    const plan = await this.prisma.weeklyPlan.findUnique({
      where: {
        householdId_weekStart: {
          householdId,
          weekStart: parseWeekStart(weekStart),
        },
      },
      include: {
        items: {
          include: PLAN_ITEM_INCLUDE,
          orderBy: [{ mealType: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });
    if (!plan) {
      throw new NotFoundException('Weekly plan not found');
    }
    return { ...plan, items: plan.items.map(withPlanItemRelationIds) };
  }

  async upsertWeekSlot(
    userId: string,
    householdId: string,
    weekStart: string,
    dto: UpsertWeekSlotDto,
  ) {
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

  async removeWeekSlot(
    userId: string,
    householdId: string,
    weekStart: string,
    dto: RemoveWeekSlotDto,
  ) {
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
    dto: SetMealEatenDto,
  ) {
    await ensureMembership(this.prisma, userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);

    const weeklyPlan = await this.prisma.weeklyPlan.findUnique({
      where: {
        householdId_weekStart: { householdId, weekStart: weekStartDate },
      },
      select: { id: true },
    });

    if (!weeklyPlan) {
      throw new NotFoundException('Weekly plan not found for this week');
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
        'Planned meal not found in this slot',
        HttpStatus.NOT_FOUND,
      );
    }

    if (dto.isEaten) {
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
    // Klamra, a nie walidacja. `ValidationPipe` owszem jest globalny
    // (`main.ts`, `useGlobalPipes`), ale na ścieżce WebSocketu nie ma czego
    // zwalidować: klasy-koperty payloadów w `weekly-plans.gateway.ts` — tu
    // `WeeklyPlansUpsertWeekSlotPayload` — nie mają ani jednego dekoratora, a
    // pole `data` nie jest opisane przez `@ValidateNested()` + `@Type(() =>
    // UpsertWeekSlotDto)`. class-validator nie zagląda więc do środka i
    // `@Min/@Max` na DTO nigdy się nie uruchamiają. Skoro klient iOS chodzi
    // wyłącznie po WS, przycięcie w kodzie jest jedyną realną obroną przed
    // `plannedServings: 0` albo `999`.
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
