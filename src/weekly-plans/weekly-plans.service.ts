import {
  ConflictException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePlanItemDto } from './dto/create-plan-item.dto';
import { CreateWeeklyPlanDto } from './dto/create-weekly-plan.dto';
import { UpsertWeekSlotDto } from './dto/upsert-week-slot.dto';
import { RemoveWeekSlotDto } from './dto/remove-week-slot.dto';
import { SetMealEatenDto } from './dto/set-meal-eaten.dto';
import {
  SaveSharedMealPlanDto,
  mergeSharedPlanRecipeIds,
  sharedPlanAddressedMealTypes,
} from './dto/save-shared-meal-plan.dto';
import { MealType, Prisma } from '@prisma/client';
import { MEAL_TYPES_IN_DAY_ORDER } from '../common/meal-types';
import { parseWeekStart } from './utils/week-formatting.util';
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

  async listByHousehold(userId: string, householdId: string) {
    await ensureMembership(this.prisma, userId, householdId);
    const plans = await this.prisma.weeklyPlan.findMany({
      where: { householdId },
      orderBy: { weekStart: 'desc' },
      include: {
        items: { include: PLAN_ITEM_INCLUDE },
      },
    });
    return plans.map((plan) => ({
      ...plan,
      items: plan.items.map(withPlanItemRelationIds),
    }));
  }

  async getByHouseholdAndWeek(
    userId: string,
    householdId: string,
    weekStart: string,
  ) {
    await ensureMembership(this.prisma, userId, householdId);
    const plan = await this.prisma.weeklyPlan.findUnique({
      where: {
        householdId_weekStart: { householdId, weekStart: new Date(weekStart) },
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

  async create(userId: string, householdId: string, dto: CreateWeeklyPlanDto) {
    await ensureMembership(this.prisma, userId, householdId);
    return this.prisma.weeklyPlan.create({
      data: {
        householdId,
        weekStart: new Date(dto.weekStart),
      },
    });
  }

  async addItem(userId: string, weeklyPlanId: string, dto: CreatePlanItemDto) {
    const plan = await this.prisma.weeklyPlan.findUnique({
      where: { id: weeklyPlanId },
    });
    if (!plan) {
      throw new NotFoundException('Weekly plan not found');
    }
    await ensureMembership(this.prisma, userId, plan.householdId);

    await ensureRecipeForHousehold(this.prisma, dto.recipeId, plan.householdId);

    // Ścieżka zaszła: `addItem` w ogóle nie zna audytorium — nie zakłada
    // `PlanItemParticipant` — a klient iOS jej nie woła, bo chodzi wyłącznie
    // przez `upsertWeekSlot`. Zostaje więc REST i starsze integracje, dla
    // których „bez uczestników" znaczy „Wspólne", czyli tyle porcji, ilu
    // domowników. Bez tego item wylądowałby na `@default(1)` ze schematu
    // i lista zakupów kupiłaby jedzenie dla jednej osoby.
    const { memberCount } = await this.resolveParticipants(plan.householdId);
    const plannedServings = this.resolvePlannedServings([], memberCount);

    return this.prisma.$transaction(async (tx) => {
      const [existingForMealType, existingTotal, variantsInSlot, sameRecipe] =
        await Promise.all([
          tx.planItem.count({
            where: {
              weeklyPlanId,
              mealType: dto.mealType,
            },
          }),
          tx.planItem.count({
            where: { weeklyPlanId },
          }),
          tx.planItem.count({
            where: {
              weeklyPlanId,
              dayOfWeek: dto.dayOfWeek,
              mealType: dto.mealType,
            },
          }),
          // A slot may hold several recipes (one per household split), so the
          // conflict is now "this exact recipe is already in this slot".
          tx.planItem.findFirst({
            where: {
              weeklyPlanId,
              dayOfWeek: dto.dayOfWeek,
              mealType: dto.mealType,
              recipeId: dto.recipeId,
            },
          }),
        ]);

      if (sameRecipe) {
        throw new ConflictException(
          'This recipe is already assigned to that day and meal slot',
        );
      }

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

      let createdItem;
      try {
        createdItem = await tx.planItem.create({
          data: {
            weeklyPlanId,
            recipeId: dto.recipeId,
            dayOfWeek: dto.dayOfWeek,
            mealType: dto.mealType,
            plannedServings,
          },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw new ConflictException(
            'This recipe is already assigned to that day and meal slot',
          );
        }
        throw error;
      }

      await this.shoppingListService.markShoppingListStale(
        plan.householdId,
        plan.weekStart,
        tx,
      );

      return createdItem;
    });
  }

  async removeItem(userId: string, itemId: string) {
    const item = await this.prisma.planItem.findUnique({
      where: { id: itemId },
      include: { weeklyPlan: true },
    });
    if (!item) {
      throw new NotFoundException('Plan item not found');
    }
    await ensureMembership(this.prisma, userId, item.weeklyPlan.householdId);
    return this.prisma.$transaction(async (tx) => {
      try {
        const deletedItem = await tx.planItem.delete({ where: { id: itemId } });
        await this.shoppingListService.markShoppingListStale(
          item.weeklyPlan.householdId,
          item.weeklyPlan.weekStart,
          tx,
        );
        return deletedItem;
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2025'
        ) {
          throw new NotFoundException('Plan item not found');
        }
        throw error;
      }
    });
  }

  async upsertWeekSlot(
    userId: string,
    householdId: string,
    weekStart: string,
    dto: UpsertWeekSlotDto,
  ) {
    await ensureMembership(this.prisma, userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);
    await ensureRecipeForHousehold(this.prisma, dto.recipeId, householdId);
    const { participantIds, memberCount } = await this.resolveParticipants(
      householdId,
      dto.participantIds,
    );
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
        const plannedServingsForUpdate = this.resolveUpdatedPlannedServings({
          currentPlannedServings: existingItem.plannedServings,
          currentParticipantIds: existingItem.participants.map((p) => p.userId),
          nextParticipantIds: participantIds,
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
              create: participantIds.map((id) => ({ userId: id })),
            },
          },
          include: PLAN_ITEM_INCLUDE,
        });
        await this.shoppingListService.markShoppingListStale(
          householdId,
          weekStartDate,
          tx,
        );
        return withPlanItemRelationIds(updatedItem);
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

      const createdItem = await tx.planItem.create({
        data: {
          weeklyPlanId: weeklyPlan.id,
          dayOfWeek: dto.dayOfWeek,
          mealType: dto.mealType,
          recipeId: dto.recipeId,
          plannedServings: plannedServingsForCreate,
          participants: {
            create: participantIds.map((id) => ({ userId: id })),
          },
        },
        include: PLAN_ITEM_INCLUDE,
      });

      await this.shoppingListService.markShoppingListStale(
        householdId,
        weekStartDate,
        tx,
      );

      return withPlanItemRelationIds(createdItem);
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
      throw new NotFoundException('Planned meal not found in this slot');
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
      return Math.min(12, Math.max(1, Math.trunc(requested)));
    }
    const eaters =
      participantIds.length > 0 ? participantIds.length : memberCount;
    return Math.min(12, Math.max(1, eaters));
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

      const sharedPlan = await tx.sharedMealPlan.findUnique({
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

      if (sharedPlan) {
        await tx.sharedMealPlanItem.deleteMany({
          where: { sharedMealPlanId: sharedPlan.id },
        });
        await tx.sharedMealPlan.delete({
          where: { id: sharedPlan.id },
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

  async getSharedMealPlan(
    userId: string,
    householdId: string,
    weekStart: string,
  ) {
    await ensureMembership(this.prisma, userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);

    const plan = await this.prisma.sharedMealPlan.findUnique({
      where: {
        householdId_weekStart: {
          householdId,
          weekStart: weekStartDate,
        },
      },
      include: {
        items: {
          include: {
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
                sourceInstructions: true,
              },
            },
          },
          orderBy: [{ mealType: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });

    if (!plan) {
      return {
        weekStart,
        items: [],
      };
    }

    return {
      weekStart,
      items: plan.items.map((item) => ({
        mealType: item.mealType,
        quantity: item.quantity,
        recipe: item.recipe,
      })),
    };
  }

  async saveSharedMealPlan(
    userId: string,
    householdId: string,
    weekStart: string,
    dto: SaveSharedMealPlanDto,
  ) {
    await ensureMembership(this.prisma, userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);

    // Jedna mapa slot → id, niezależnie od tego, czy klient przysłał nową
    // formę (`recipeIdsByMealType`), czy jeszcze trzy stare pola.
    const recipeIdsByMealType = mergeSharedPlanRecipeIds(dto);

    // Zakres zapisu. Starszy klient nie zna dodatkowych slotów i nie ma jak
    // się o nich wypowiedzieć — jego zapis nie może ich skasować.
    const addressedMealTypes = sharedPlanAddressedMealTypes(dto);

    const allIds = Object.values(recipeIdsByMealType).flat();
    const uniqueIds = Array.from(new Set(allIds));

    const countByRecipe = (ids: string[]) =>
      ids.reduce<Map<string, number>>((map, id) => {
        map.set(id, (map.get(id) ?? 0) + 1);
        return map;
      }, new Map<string, number>());

    const countsByMealType = new Map<MealType, Map<string, number>>(
      MEAL_TYPES_IN_DAY_ORDER.map(
        (mealType): [MealType, Map<string, number>] => [
          mealType,
          countByRecipe(recipeIdsByMealType[mealType]),
        ],
      ),
    );

    await runSerializable(this.prisma, async (tx) => {
      await tx.shoppingListArchiveState.deleteMany({
        where: {
          householdId,
          weekStart: weekStartDate,
          currentArchiveId: null,
        },
      });

      if (uniqueIds.length > 0) {
        const recipes = await tx.recipe.findMany({
          where: {
            id: { in: uniqueIds },
          },
          select: { id: true },
        });

        if (recipes.length !== uniqueIds.length) {
          throw new NotFoundException(
            'One or more recipes from shared plan do not exist',
          );
        }
      }

      const sharedPlan = await tx.sharedMealPlan.upsert({
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

      const rows = Array.from(countsByMealType.entries())
        .flatMap(([mealType, counts]) =>
          Array.from(counts.entries()).map(([recipeId, quantity]) => ({
            sharedMealPlanId: sharedPlan.id,
            recipeId,
            mealType,
            quantity,
          })),
        )
        .filter((row) => row.quantity > 0);

      await tx.sharedMealPlanItem.deleteMany({
        where: {
          sharedMealPlanId: sharedPlan.id,
          mealType: { in: addressedMealTypes },
        },
      });

      if (rows.length > 0) {
        await tx.sharedMealPlanItem.createMany({
          data: rows,
        });
      }

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
        await this.shoppingListService.markShoppingListStale(
          householdId,
          weekStartDate,
          tx,
        );
        return;
      }

      const pruneByMealType = async (
        mealType: MealType,
        allowedRecipeIds: string[],
      ) => {
        if (allowedRecipeIds.length === 0) {
          await tx.planItem.deleteMany({
            where: {
              weeklyPlanId: weeklyPlan.id,
              mealType,
            },
          });
          return;
        }

        await tx.planItem.deleteMany({
          where: {
            weeklyPlanId: weeklyPlan.id,
            mealType,
            recipeId: { notIn: allowedRecipeIds },
          },
        });
      };

      // Przycinamy **każdy** slot, także wyłączony w gospodarstwie: pula na
      // tydzień jest zapisem pełnym, a slot nieobecny w ładunku znaczy „nic
      // tu nie planujemy". Gdyby pominąć wyłączone, po ich ponownym
      // włączeniu wracałyby dania sprzed kilku tygodni.
      await Promise.all(
        Array.from(countsByMealType.entries()).map(([mealType, counts]) =>
          pruneByMealType(mealType, Array.from(counts.keys())),
        ),
      );

      await this.shoppingListService.markShoppingListStale(
        householdId,
        weekStartDate,
        tx,
      );
    });

    return this.getSharedMealPlan(userId, householdId, weekStart);
  }
}
