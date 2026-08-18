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
import { SaveSharedMealPlanDto } from './dto/save-shared-meal-plan.dto';
import { Prisma } from '@prisma/client';
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
} satisfies Prisma.PlanItemInclude;

/**
 * Flattens the participant join rows into the flat `participantIds` array the
 * clients read (see `PlanItemDto`). Without this the wire shape would leak the
 * junction table as `participants: [{ userId }]`.
 */
function withParticipantIds<T extends { participants?: { userId: string }[] }>(
  item: T,
): Omit<T, 'participants'> & { participantIds: string[] } {
  const { participants, ...rest } = item;
  return {
    ...rest,
    participantIds: (participants ?? []).map((p) => p.userId),
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
   * slot, so 7 days × 6 per meal type, and 3 meal types in total.
   */
  private static readonly MAX_VARIANTS_PER_SLOT = 6;
  private static readonly MAX_ITEMS_PER_MEAL_TYPE = 7 * 6;
  private static readonly MAX_ITEMS_TOTAL = 7 * 6 * 3;

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
      items: plan.items.map(withParticipantIds),
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
    return { ...plan, items: plan.items.map(withParticipantIds) };
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
    const participantIds = await this.resolveParticipants(
      householdId,
      dto.participantIds,
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
      const existingItem = await tx.planItem.findFirst({
        where: {
          weeklyPlanId: weeklyPlan.id,
          dayOfWeek: dto.dayOfWeek,
          mealType: dto.mealType,
          recipeId: dto.recipeId,
        },
        select: { id: true },
      });

      if (existingItem) {
        await tx.planItemParticipant.deleteMany({
          where: { planItemId: existingItem.id },
        });
        const updatedItem = await tx.planItem.update({
          where: { id: existingItem.id },
          data: {
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
        return withParticipantIds(updatedItem);
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

      return withParticipantIds(createdItem);
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
   * Narrows a requested audience down to real household members.
   *
   * An empty result means „Wspólne" — the meal is for the whole household.
   * Naming every member says exactly the same thing, so it collapses to empty
   * and the app keeps showing a single house badge instead of N avatars.
   */
  private async resolveParticipants(
    householdId: string,
    requested?: string[],
  ): Promise<string[]> {
    const unique = Array.from(new Set(requested ?? []));
    if (unique.length === 0) {
      return [];
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

    return unique.length === memberIds.size ? [] : unique;
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

    const breakfast = dto.breakfastRecipeIds ?? [];
    const lunch = dto.lunchRecipeIds ?? [];
    const dinner = dto.dinnerRecipeIds ?? [];

    const allIds = [...breakfast, ...lunch, ...dinner];
    const uniqueIds = Array.from(new Set(allIds));

    const countByRecipe = (ids: string[]) =>
      ids.reduce<Map<string, number>>((map, id) => {
        map.set(id, (map.get(id) ?? 0) + 1);
        return map;
      }, new Map<string, number>());

    const breakfastCounts = countByRecipe(breakfast);
    const lunchCounts = countByRecipe(lunch);
    const dinnerCounts = countByRecipe(dinner);
    const breakfastAllowed = Array.from(breakfastCounts.keys());
    const lunchAllowed = Array.from(lunchCounts.keys());
    const dinnerAllowed = Array.from(dinnerCounts.keys());

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

      const rows = [
        ...Array.from(breakfastCounts.entries()).map(
          ([recipeId, quantity]) => ({
            sharedMealPlanId: sharedPlan.id,
            recipeId,
            mealType: 'BREAKFAST' as const,
            quantity,
          }),
        ),
        ...Array.from(lunchCounts.entries()).map(([recipeId, quantity]) => ({
          sharedMealPlanId: sharedPlan.id,
          recipeId,
          mealType: 'LUNCH' as const,
          quantity,
        })),
        ...Array.from(dinnerCounts.entries()).map(([recipeId, quantity]) => ({
          sharedMealPlanId: sharedPlan.id,
          recipeId,
          mealType: 'DINNER' as const,
          quantity,
        })),
      ].filter((row) => row.quantity > 0);

      await tx.sharedMealPlanItem.deleteMany({
        where: {
          sharedMealPlanId: sharedPlan.id,
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
        mealType: 'BREAKFAST' | 'LUNCH' | 'DINNER',
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

      await Promise.all([
        pruneByMealType('BREAKFAST', breakfastAllowed),
        pruneByMealType('LUNCH', lunchAllowed),
        pruneByMealType('DINNER', dinnerAllowed),
      ]);

      await this.shoppingListService.markShoppingListStale(
        householdId,
        weekStartDate,
        tx,
      );
    });

    return this.getSharedMealPlan(userId, householdId, weekStart);
  }
}
