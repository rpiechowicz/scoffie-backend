import {
  ConflictException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException } from '../../common/app-exception';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateShoppingItemCheckDto } from '../dto/update-shopping-item-check.dto';
import type {
  ShoppingAccumulator,
  ShoppingListItem,
  ShoppingListStateDto,
  PrismaReadClient,
} from '../types/shopping-types';
import {
  parseWeekStart,
  formatWeekStart,
} from '../utils/week-formatting.util';
import { normalizeProductKey } from '../utils/text-normalization.util';
import {
  canonicalizeIngredientName,
  resolveDepartment,
} from '../utils/department-classifier.util';
import {
  itemSignature,
  buildDisplayShoppingItems,
  mapSnapshotItems,
  toArchiveSnapshot,
} from '../utils/shopping-items.util';
import { ensureMembership } from '../utils/auth-checks.util';
import { runSerializable } from '../utils/transaction-runner.util';

/// Owns the per-household shopping list aggregation, snapshotting,
/// archival, and item-check operations. Split out of WeeklyPlansService
/// so the plan-management surface stays focused.
///
/// Snapshot model: every household has a single "current" `ShoppingList`
/// row per week, plus zero or more archived snapshots. Recompute fans
/// out from `rebuildShoppingListSnapshot`, gated by `markShoppingListStale`
/// so we don't do work for weeks the UI isn't looking at.
@Injectable()
export class ShoppingListService {
  constructor(private readonly prisma: PrismaService) {}

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

  async markShoppingListStale(
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
    await ensureMembership(this.prisma, userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);
    return this.getShoppingListSnapshot(householdId, weekStartDate);
  }

  async getShoppingListState(
    userId: string,
    householdId: string,
    weekStart: string,
  ): Promise<ShoppingListStateDto> {
    await ensureMembership(this.prisma, userId, householdId);
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
    await ensureMembership(this.prisma, userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);

    return runSerializable(this.prisma, async (tx) => {
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
    await ensureMembership(this.prisma, userId, householdId);

    return runSerializable(this.prisma, async (tx) => {
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
    await ensureMembership(this.prisma, userId, householdId);

    return runSerializable(this.prisma, async (tx) => {
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
    await ensureMembership(this.prisma, userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);

    return runSerializable(this.prisma, async (tx) => {
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
    await ensureMembership(this.prisma, userId, householdId);
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
}
