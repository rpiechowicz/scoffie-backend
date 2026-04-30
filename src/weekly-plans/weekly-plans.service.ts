import {
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePlanItemDto } from './dto/create-plan-item.dto';
import { CreateWeeklyPlanDto } from './dto/create-weekly-plan.dto';
import { UpdateShoppingItemCheckDto } from './dto/update-shopping-item-check.dto';
import { UpsertWeekSlotDto } from './dto/upsert-week-slot.dto';
import { RemoveWeekSlotDto } from './dto/remove-week-slot.dto';
import { SaveSharedMealPlanDto } from './dto/save-shared-meal-plan.dto';
import { Prisma } from '@prisma/client';
import type {
  ShoppingAccumulator,
  ShoppingListItem,
  ShoppingListStateDto,
  PrismaReadClient,
} from './types/shopping-types';
import {
  parseWeekStart,
  formatWeekStart,
} from './utils/week-formatting.util';
import { normalizeProductKey } from './utils/text-normalization.util';
import {
  canonicalizeIngredientName,
  resolveDepartment,
} from './utils/department-classifier.util';
import {
  itemSignature,
  buildDisplayShoppingItems,
  mapSnapshotItems,
  toArchiveSnapshot,
} from './utils/shopping-items.util';

@Injectable()
export class WeeklyPlansService {
  constructor(private readonly prisma: PrismaService) {}
  private static readonly MAX_ITEMS_PER_MEAL_TYPE = 7;
  private static readonly MAX_ITEMS_TOTAL = 21;

  private async ensureRecipeForHousehold(
    recipeId: string,
    _householdId: string,
  ) {
    const recipe = await this.prisma.recipe.findUnique({
      where: { id: recipeId },
      select: { id: true },
    });
    if (!recipe) {
      throw new NotFoundException('Recipe not found');
    }
    return recipe;
  }

  private async ensureMembership(userId: string, householdId: string) {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_householdId: { userId, householdId } },
    });
    if (!membership) {
      throw new ForbiddenException('User is not a member of this household');
    }
    return membership;
  }

  private isSerializableConflict(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2034'
    );
  }

  private async runSerializable<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
    maxRetries = 2,
  ): Promise<T> {
    let attempts = 0;
    while (true) {
      try {
        return await this.prisma.$transaction(async (tx) => operation(tx), {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (this.isSerializableConflict(error) && attempts < maxRetries) {
          attempts += 1;
          continue;
        }
        throw error;
      }
    }
  }

  async listByHousehold(userId: string, householdId: string) {
    await this.ensureMembership(userId, householdId);
    return this.prisma.weeklyPlan.findMany({
      where: { householdId },
      orderBy: { weekStart: 'desc' },
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
              },
            },
          },
        },
      },
    });
  }

  async getByHouseholdAndWeek(
    userId: string,
    householdId: string,
    weekStart: string,
  ) {
    await this.ensureMembership(userId, householdId);
    const plan = await this.prisma.weeklyPlan.findUnique({
      where: {
        householdId_weekStart: { householdId, weekStart: new Date(weekStart) },
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
              },
            },
          },
        },
      },
    });
    if (!plan) {
      throw new NotFoundException('Weekly plan not found');
    }
    return plan;
  }

  async create(userId: string, householdId: string, dto: CreateWeeklyPlanDto) {
    await this.ensureMembership(userId, householdId);
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
    await this.ensureMembership(userId, plan.householdId);

    await this.ensureRecipeForHousehold(dto.recipeId, plan.householdId);

    return this.prisma.$transaction(async (tx) => {
      const [existingForMealType, existingTotal, existingSlot] =
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
          tx.planItem.findFirst({
            where: {
              weeklyPlanId,
              dayOfWeek: dto.dayOfWeek,
              mealType: dto.mealType,
            },
          }),
        ]);

      if (existingSlot) {
        throw new ConflictException(
          'This day and meal slot is already assigned in weekly plan',
        );
      }

      if (existingForMealType >= WeeklyPlansService.MAX_ITEMS_PER_MEAL_TYPE) {
        throw new AppException(
          'PLAN_SLOT_LIMIT_REACHED',
          'Meal type limit reached (max 7 per week)',
          HttpStatus.BAD_REQUEST,
        );
      }

      if (existingTotal >= WeeklyPlansService.MAX_ITEMS_TOTAL) {
        throw new AppException(
          'PLAN_TOTAL_LIMIT_REACHED',
          'Weekly plan total limit reached (max 21 items)',
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
            'This day and meal slot is already assigned in weekly plan',
          );
        }
        throw error;
      }

      await this.markShoppingListStale(plan.householdId, plan.weekStart, tx);

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
    await this.ensureMembership(userId, item.weeklyPlan.householdId);
    return this.prisma.$transaction(async (tx) => {
      try {
        const deletedItem = await tx.planItem.delete({ where: { id: itemId } });
        await this.markShoppingListStale(
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

  private async buildShoppingListBase(
    householdId: string,
    weekStartDate: Date,
    client: PrismaReadClient = this.prisma,
  ): Promise<ShoppingAccumulator[]> {
    const sharedPlan = await client.sharedMealPlan.findUnique({
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
              include: {
                ingredients: {
                  select: {
                    name: true,
                    amount: true,
                    unit: true,
                    normalizedAmount: true,
                    normalizedUnit: true,
                    department: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    let ingredientSources: Array<{
      recipe: {
        ingredients: Array<{
          name: string;
          amount: number;
          unit: string;
          normalizedAmount: number;
          normalizedUnit: string;
          department: string;
        }>;
      };
      quantity: number;
    }> = [];
    if (sharedPlan && sharedPlan.items.length > 0) {
      ingredientSources = sharedPlan.items.map((item) => ({
        recipe: item.recipe,
        quantity: Math.max(1, item.quantity),
      }));
    } else {
      // Backward compatibility fallback: if shared plan is not yet saved, derive list from calendar slots.
      const weeklyPlan = await client.weeklyPlan.findUnique({
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
                include: {
                  ingredients: {
                    select: {
                      name: true,
                      amount: true,
                      unit: true,
                      normalizedAmount: true,
                      normalizedUnit: true,
                      department: true,
                    },
                  },
                },
              },
            },
          },
        },
      });
      ingredientSources = (weeklyPlan?.items ?? []).map((item) => ({
        recipe: item.recipe,
        quantity: 1,
      }));
    }

    const aggregated = new Map<string, ShoppingAccumulator>();
    for (const source of ingredientSources) {
      for (const ingredient of source.recipe.ingredients) {
        const baseAmount = ingredient.normalizedAmount ?? ingredient.amount;
        const baseUnit = ingredient.normalizedUnit ?? ingredient.unit;
        const canonicalName = canonicalizeIngredientName(
          ingredient.name,
          baseUnit,
        );
        const productKey = normalizeProductKey(canonicalName, baseUnit);
        const current = aggregated.get(productKey);
        const amountToAdd = baseAmount * source.quantity;
        if (current) {
          current.totalAmount += amountToAdd;
          continue;
        }
        aggregated.set(productKey, {
          productKey,
          name: canonicalName,
          unit: baseUnit,
          department: resolveDepartment(
            ingredient.department,
            canonicalName,
          ),
          totalAmount: amountToAdd,
        });
      }
    }

    if (aggregated.size === 0) {
      return [];
    }

    return Array.from(aggregated.values());
  }

  private async rebuildShoppingListSnapshot(
    householdId: string,
    weekStartDate: Date,
    tx: Prisma.TransactionClient,
  ): Promise<ShoppingListItem[]> {
    const aggregatedItems = await this.buildShoppingListBase(
      householdId,
      weekStartDate,
      tx,
    );

    const shoppingList = await tx.shoppingList.upsert({
      where: {
        householdId_weekStart: {
          householdId,
          weekStart: weekStartDate,
        },
      },
      update: {
        isStale: false,
        updatedAt: new Date(),
      },
      create: {
        householdId,
        weekStart: weekStartDate,
        isStale: false,
      },
      include: {
        items: {
          select: {
            productKey: true,
            isChecked: true,
          },
        },
      },
    });
    const currentArchiveState = await tx.shoppingListArchiveState.findUnique({
      where: {
        householdId_weekStart: {
          householdId,
          weekStart: weekStartDate,
        },
      },
      select: {
        currentArchiveId: true,
        currentArchive: {
          select: {
            items: {
              select: {
                productKey: true,
                totalAmount: true,
              },
            },
          },
        },
      },
    });

    const productKeys = aggregatedItems.map((item) => item.productKey);
    const legacyChecks =
      productKeys.length > 0
        ? await tx.shoppingItemCheck.findMany({
            where: {
              householdId,
              weekStart: weekStartDate,
              productKey: {
                in: productKeys,
              },
            },
            select: {
              productKey: true,
              isChecked: true,
            },
          })
        : [];

    const existingCheckedMap = new Map(
      shoppingList.items.map((item) => [item.productKey, item.isChecked]),
    );
    const legacyCheckedMap = new Map(
      legacyChecks.map((item) => [item.productKey, item.isChecked]),
    );
    const baselineAmounts = new Map(
      (currentArchiveState?.currentArchive?.items ?? []).map((item) => [
        item.productKey,
        item.totalAmount,
      ]),
    );
    const checkedMap = new Map<string, boolean>();
    for (const item of aggregatedItems) {
      const previousAmount = baselineAmounts.get(item.productKey) ?? 0;
      const hasNewUncheckedDelta = Boolean(
        currentArchiveState?.currentArchiveId &&
        item.totalAmount > previousAmount + 0.000_001,
      );

      checkedMap.set(
        item.productKey,
        hasNewUncheckedDelta
          ? false
          : (existingCheckedMap.get(item.productKey) ??
              legacyCheckedMap.get(item.productKey) ??
              false),
      );
    }

    const nextItems = buildDisplayShoppingItems(
      aggregatedItems,
      checkedMap,
    );

    if (nextItems.length === 0) {
      await tx.shoppingListItem.deleteMany({
        where: { shoppingListId: shoppingList.id },
      });
      await tx.shoppingItemCheck.deleteMany({
        where: {
          householdId,
          weekStart: weekStartDate,
        },
      });
      return [];
    }

    await tx.shoppingListItem.deleteMany({
      where: {
        shoppingListId: shoppingList.id,
        productKey: {
          notIn: nextItems.map((item) => item.productKey),
        },
      },
    });

    await tx.shoppingItemCheck.deleteMany({
      where: {
        householdId,
        weekStart: weekStartDate,
        productKey: {
          notIn: nextItems.map((item) => item.productKey),
        },
      },
    });

    for (const item of nextItems) {
      await tx.shoppingListItem.upsert({
        where: {
          shoppingListId_productKey: {
            shoppingListId: shoppingList.id,
            productKey: item.productKey,
          },
        },
        update: {
          name: item.name,
          unit: item.unit,
          department: item.department,
          totalAmount: item.totalAmount,
          isChecked: item.isChecked,
        },
        create: {
          shoppingListId: shoppingList.id,
          productKey: item.productKey,
          name: item.name,
          unit: item.unit,
          department: item.department,
          totalAmount: item.totalAmount,
          isChecked: item.isChecked,
        },
      });
    }

    return nextItems;
  }

  private async hasShoppingSourceData(
    householdId: string,
    weekStartDate: Date,
    client: PrismaReadClient = this.prisma,
  ): Promise<boolean> {
    const [sharedPlan, weeklyPlan] = await Promise.all([
      client.sharedMealPlan.findUnique({
        where: {
          householdId_weekStart: {
            householdId,
            weekStart: weekStartDate,
          },
        },
        select: {
          items: {
            select: { id: true },
            take: 1,
          },
        },
      }),
      client.weeklyPlan.findUnique({
        where: {
          householdId_weekStart: {
            householdId,
            weekStart: weekStartDate,
          },
        },
        select: {
          items: {
            select: { id: true },
            take: 1,
          },
        },
      }),
    ]);

    return (
      (sharedPlan?.items.length ?? 0) > 0 || (weeklyPlan?.items.length ?? 0) > 0
    );
  }

  private async rebuildShoppingListSnapshotWithClient(
    householdId: string,
    weekStartDate: Date,
    client: PrismaReadClient = this.prisma,
  ): Promise<ShoppingListItem[]> {
    if (client === this.prisma) {
      return this.prisma.$transaction((tx) =>
        this.rebuildShoppingListSnapshot(householdId, weekStartDate, tx),
      );
    }

    return this.rebuildShoppingListSnapshot(
      householdId,
      weekStartDate,
      client as Prisma.TransactionClient,
    );
  }

  private async markShoppingListStale(
    householdId: string,
    weekStartDate: Date,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.shoppingList.upsert({
      where: {
        householdId_weekStart: {
          householdId,
          weekStart: weekStartDate,
        },
      },
      update: {
        isStale: true,
        updatedAt: new Date(),
      },
      create: {
        householdId,
        weekStart: weekStartDate,
        isStale: true,
      },
      select: { id: true },
    });
  }

  private async getShoppingListSnapshot(
    householdId: string,
    weekStartDate: Date,
    client: PrismaReadClient = this.prisma,
  ): Promise<ShoppingListItem[]> {
    const snapshot = await client.shoppingList.findUnique({
      where: {
        householdId_weekStart: {
          householdId,
          weekStart: weekStartDate,
        },
      },
      include: {
        items: true,
      },
    });

    if (snapshot) {
      if (snapshot.isStale) {
        return this.rebuildShoppingListSnapshotWithClient(
          householdId,
          weekStartDate,
          client,
        );
      }
      const hasSourceData = await this.hasShoppingSourceData(
        householdId,
        weekStartDate,
        client,
      );
      if (snapshot.items.length === 0 && hasSourceData) {
        return this.rebuildShoppingListSnapshotWithClient(
          householdId,
          weekStartDate,
          client,
        );
      }
      if (snapshot.items.length > 0 && !hasSourceData) {
        return this.rebuildShoppingListSnapshotWithClient(
          householdId,
          weekStartDate,
          client,
        );
      }
      return mapSnapshotItems(snapshot.items);
    }

    return this.rebuildShoppingListSnapshotWithClient(
      householdId,
      weekStartDate,
      client,
    );
  }

  async getShoppingList(
    userId: string,
    householdId: string,
    weekStart: string,
  ) {
    await this.ensureMembership(userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);
    return this.getShoppingListSnapshot(householdId, weekStartDate);
  }

  async getShoppingListState(
    userId: string,
    householdId: string,
    weekStart: string,
  ): Promise<ShoppingListStateDto> {
    await this.ensureMembership(userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);

    const [items, archives, currentArchiveStates, currentWeekArchiveState] =
      await Promise.all([
        this.getShoppingListSnapshot(householdId, weekStartDate),
        this.prisma.shoppingListArchive.findMany({
          where: { householdId },
          orderBy: [{ archivedAt: 'desc' }, { revision: 'desc' }],
          include: {
            items: {
              orderBy: [{ department: 'asc' }, { name: 'asc' }],
            },
          },
        }),
        this.prisma.shoppingListArchiveState.findMany({
          where: {
            householdId,
            currentArchiveId: { not: null },
          },
          select: {
            currentArchiveId: true,
          },
        }),
        this.prisma.shoppingListArchiveState.findUnique({
          where: {
            householdId_weekStart: {
              householdId,
              weekStart: weekStartDate,
            },
          },
          select: {
            currentArchiveId: true,
          },
        }),
      ]);

    const currentArchiveIds = new Set(
      currentArchiveStates
        .map((state) => state.currentArchiveId)
        .filter((value): value is string => Boolean(value)),
    );
    const shouldHideCurrentWeekList =
      currentWeekArchiveState?.currentArchiveId === null;

    return {
      items: shouldHideCurrentWeekList ? [] : items,
      archives: archives.map((archive) =>
        toArchiveSnapshot(archive, currentArchiveIds),
      ),
    };
  }

  async archiveShoppingList(
    userId: string,
    householdId: string,
    weekStart: string,
    weekLabel: string,
  ) {
    await this.ensureMembership(userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);

    return this.runSerializable(async (tx) => {
      const items = await this.getShoppingListSnapshot(
        householdId,
        weekStartDate,
        tx,
      );

      if (items.length === 0) {
        throw new AppException(
          'SHOPPING_LIST_EMPTY',
          'Shopping list is empty and cannot be archived',
          HttpStatus.BAD_REQUEST,
        );
      }

      if (items.some((item) => !item.isChecked)) {
        throw new AppException(
          'SHOPPING_LIST_NOT_COMPLETED',
          'Shopping list must be fully checked before archiving',
          HttpStatus.BAD_REQUEST,
        );
      }

      const signature = itemSignature(items);
      const now = new Date();
      const existingArchive = await tx.shoppingListArchive.findUnique({
        where: {
          householdId_weekStart_signature: {
            householdId,
            weekStart: weekStartDate,
            signature,
          },
        },
        select: {
          id: true,
          revision: true,
        },
      });

      let archiveId: string;
      if (existingArchive) {
        archiveId = existingArchive.id;
        await tx.shoppingListArchive.update({
          where: { id: existingArchive.id },
          data: {
            weekLabel,
            archivedAt: now,
          },
        });
      } else {
        const revisionAggregate = await tx.shoppingListArchive.aggregate({
          where: {
            householdId,
            weekStart: weekStartDate,
          },
          _max: { revision: true },
        });

        const createdArchive = await tx.shoppingListArchive.create({
          data: {
            householdId,
            weekStart: weekStartDate,
            weekLabel,
            revision: (revisionAggregate._max.revision ?? 0) + 1,
            signature,
            archivedAt: now,
            items: {
              create: items.map((item) => ({
                productKey: item.productKey,
                name: item.name,
                unit: item.unit,
                department: item.department,
                totalAmount: item.totalAmount,
                isChecked: item.isChecked,
              })),
            },
          },
          select: { id: true },
        });
        archiveId = createdArchive.id;
      }

      await tx.shoppingListArchiveState.upsert({
        where: {
          householdId_weekStart: {
            householdId,
            weekStart: weekStartDate,
          },
        },
        update: {
          currentArchiveId: archiveId,
        },
        create: {
          householdId,
          weekStart: weekStartDate,
          currentArchiveId: archiveId,
        },
      });

      return { archiveId };
    });
  }

  async selectShoppingListArchive(
    userId: string,
    householdId: string,
    archiveId: string,
  ) {
    await this.ensureMembership(userId, householdId);

    return this.runSerializable(async (tx) => {
      const archive = await tx.shoppingListArchive.findUnique({
        where: { id: archiveId },
        select: {
          id: true,
          householdId: true,
          weekStart: true,
        },
      });

      if (!archive || archive.householdId !== householdId) {
        throw new NotFoundException('Shopping list archive not found');
      }

      await tx.shoppingListArchiveState.upsert({
        where: {
          householdId_weekStart: {
            householdId,
            weekStart: archive.weekStart,
          },
        },
        update: {
          currentArchiveId: archive.id,
        },
        create: {
          householdId,
          weekStart: archive.weekStart,
          currentArchiveId: archive.id,
        },
      });

      return {
        archiveId: archive.id,
        weekStart: formatWeekStart(archive.weekStart),
      };
    });
  }

  async deleteShoppingListArchive(
    userId: string,
    householdId: string,
    archiveId: string,
  ) {
    await this.ensureMembership(userId, householdId);

    return this.runSerializable(async (tx) => {
      const archive = await tx.shoppingListArchive.findUnique({
        where: { id: archiveId },
        select: {
          id: true,
          householdId: true,
          weekStart: true,
        },
      });

      if (!archive || archive.householdId !== householdId) {
        throw new NotFoundException('Shopping list archive not found');
      }

      const weekStart = archive.weekStart;

      await tx.shoppingListArchive.delete({
        where: { id: archive.id },
      });

      const replacementArchive = await tx.shoppingListArchive.findFirst({
        where: {
          householdId,
          weekStart,
        },
        orderBy: [{ archivedAt: 'desc' }, { revision: 'desc' }],
        select: { id: true },
      });

      if (replacementArchive) {
        await tx.shoppingListArchiveState.upsert({
          where: {
            householdId_weekStart: {
              householdId,
              weekStart,
            },
          },
          update: {
            currentArchiveId: replacementArchive.id,
          },
          create: {
            householdId,
            weekStart,
            currentArchiveId: replacementArchive.id,
          },
        });
      } else {
        await tx.shoppingListArchiveState.upsert({
          where: {
            householdId_weekStart: {
              householdId,
              weekStart,
            },
          },
          update: {
            currentArchiveId: null,
          },
          create: {
            householdId,
            weekStart,
            currentArchiveId: null,
          },
        });
      }

      return {
        archiveId,
        weekStart: formatWeekStart(weekStart),
      };
    });
  }

  async deleteAllShoppingListArchives(
    userId: string,
    householdId: string,
    weekStart: string,
  ) {
    await this.ensureMembership(userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);

    return this.runSerializable(async (tx) => {
      await tx.shoppingListArchiveState.deleteMany({
        where: { householdId },
      });
      await tx.shoppingListArchive.deleteMany({
        where: { householdId },
      });
      await tx.shoppingListArchiveState.create({
        data: {
          householdId,
          weekStart: weekStartDate,
          currentArchiveId: null,
        },
      });

      return { success: true };
    });
  }

  async setShoppingItemChecked(
    userId: string,
    householdId: string,
    weekStart: string,
    dto: UpdateShoppingItemCheckDto,
  ) {
    await this.ensureMembership(userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);

    return this.prisma.$transaction(async (tx) => {
      await this.getShoppingListSnapshot(householdId, weekStartDate, tx);

      const snapshot = await tx.shoppingList.findUnique({
        where: {
          householdId_weekStart: {
            householdId,
            weekStart: weekStartDate,
          },
        },
        select: {
          id: true,
          items: {
            where: {
              productKey: dto.productKey,
            },
            select: {
              productKey: true,
            },
          },
        },
      });

      if (!snapshot || snapshot.items.length === 0) {
        throw new NotFoundException(
          'Shopping item not found for this household and week',
        );
      }

      await tx.shoppingListItem.update({
        where: {
          shoppingListId_productKey: {
            shoppingListId: snapshot.id,
            productKey: dto.productKey,
          },
        },
        data: {
          isChecked: dto.isChecked,
        },
      });

      return tx.shoppingItemCheck.upsert({
        where: {
          householdId_weekStart_productKey: {
            householdId,
            weekStart: weekStartDate,
            productKey: dto.productKey,
          },
        },
        update: {
          isChecked: dto.isChecked,
        },
        create: {
          householdId,
          weekStart: weekStartDate,
          productKey: dto.productKey,
          isChecked: dto.isChecked,
        },
      });
    });
  }

  async upsertWeekSlot(
    userId: string,
    householdId: string,
    weekStart: string,
    dto: UpsertWeekSlotDto,
  ) {
    await this.ensureMembership(userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);
    await this.ensureRecipeForHousehold(dto.recipeId, householdId);

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

      const existingSlot = await tx.planItem.findFirst({
        where: {
          weeklyPlanId: weeklyPlan.id,
          dayOfWeek: dto.dayOfWeek,
          mealType: dto.mealType,
        },
      });

      if (existingSlot) {
        const updatedItem = await tx.planItem.update({
          where: { id: existingSlot.id },
          data: { recipeId: dto.recipeId },
        });
        await this.markShoppingListStale(householdId, weekStartDate, tx);
        return updatedItem;
      }

      const [existingForMealType, existingTotal] = await Promise.all([
        tx.planItem.count({
          where: {
            weeklyPlanId: weeklyPlan.id,
            mealType: dto.mealType,
          },
        }),
        tx.planItem.count({
          where: { weeklyPlanId: weeklyPlan.id },
        }),
      ]);

      if (existingForMealType >= WeeklyPlansService.MAX_ITEMS_PER_MEAL_TYPE) {
        throw new AppException(
          'PLAN_SLOT_LIMIT_REACHED',
          'Meal type limit reached (max 7 per week)',
          HttpStatus.BAD_REQUEST,
        );
      }

      if (existingTotal >= WeeklyPlansService.MAX_ITEMS_TOTAL) {
        throw new AppException(
          'PLAN_TOTAL_LIMIT_REACHED',
          'Weekly plan total limit reached (max 21 items)',
          HttpStatus.BAD_REQUEST,
        );
      }

      const createdItem = await tx.planItem.upsert({
        where: {
          weeklyPlanId_dayOfWeek_mealType: {
            weeklyPlanId: weeklyPlan.id,
            dayOfWeek: dto.dayOfWeek,
            mealType: dto.mealType,
          },
        },
        update: { recipeId: dto.recipeId },
        create: {
          weeklyPlanId: weeklyPlan.id,
          dayOfWeek: dto.dayOfWeek,
          mealType: dto.mealType,
          recipeId: dto.recipeId,
        },
      });

      await this.markShoppingListStale(householdId, weekStartDate, tx);

      return createdItem;
    });
  }

  async removeWeekSlot(
    userId: string,
    householdId: string,
    weekStart: string,
    dto: RemoveWeekSlotDto,
  ) {
    await this.ensureMembership(userId, householdId);
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

      const existingSlot = await tx.planItem.findFirst({
        where: {
          weeklyPlanId: weeklyPlan.id,
          dayOfWeek: dto.dayOfWeek,
          mealType: dto.mealType,
        },
        select: { id: true },
      });

      if (!existingSlot) {
        return null;
      }

      try {
        const deletedItem = await tx.planItem.delete({
          where: { id: existingSlot.id },
        });
        await this.markShoppingListStale(householdId, weekStartDate, tx);
        return deletedItem;
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2025'
        ) {
          return null;
        }
        throw error;
      }
    });
  }

  async clearWeekPlan(userId: string, householdId: string, weekStart: string) {
    await this.ensureMembership(userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);

    await this.runSerializable(async (tx) => {
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
    await this.ensureMembership(userId, householdId);
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
    await this.ensureMembership(userId, householdId);
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

    await this.runSerializable(async (tx) => {
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
        await this.markShoppingListStale(householdId, weekStartDate, tx);
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

      await this.markShoppingListStale(householdId, weekStartDate, tx);
    });

    return this.getSharedMealPlan(userId, householdId, weekStart);
  }
}
