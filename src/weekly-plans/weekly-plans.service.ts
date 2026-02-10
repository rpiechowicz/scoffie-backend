import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePlanItemDto } from './dto/create-plan-item.dto';
import { CreateWeeklyPlanDto } from './dto/create-weekly-plan.dto';
import { UpdateShoppingItemCheckDto } from './dto/update-shopping-item-check.dto';

type ShoppingAccumulator = {
  productKey: string;
  name: string;
  unit: string;
  department: string;
  totalAmount: number;
};

@Injectable()
export class WeeklyPlansService {
  constructor(private readonly prisma: PrismaService) {}
  private static readonly MAX_ITEMS_PER_MEAL_TYPE = 7;
  private static readonly MAX_ITEMS_TOTAL = 21;

  private parseWeekStart(weekStart: string): Date {
    const parsed = new Date(weekStart);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException('Invalid weekStart date format');
    }
    return parsed;
  }

  private normalizeProductKey(name: string, unit: string): string {
    return `${name.trim().toLowerCase()}::${unit.trim().toLowerCase()}`;
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
                authorId: true,
                householdId: true,
              },
            },
          },
        },
      },
    });
  }

  async getByHouseholdAndWeek(userId: string, householdId: string, weekStart: string) {
    await this.ensureMembership(userId, householdId);
    const plan = await this.prisma.weeklyPlan.findUnique({
      where: { householdId_weekStart: { householdId, weekStart: new Date(weekStart) } },
      include: {
        items: {
          include: {
            recipe: {
              select: {
                id: true,
                title: true,
                description: true,
                authorId: true,
                householdId: true,
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

    const recipe = await this.prisma.recipe.findUnique({
      where: { id: dto.recipeId },
      select: { id: true, householdId: true },
    });
    if (!recipe) {
      throw new NotFoundException('Recipe not found');
    }
    if (recipe.householdId !== plan.householdId) {
      throw new BadRequestException('Recipe does not belong to this household');
    }

    const [existingForMealType, existingTotal, existingSlot] = await Promise.all([
      this.prisma.planItem.count({
        where: {
          weeklyPlanId,
          mealType: dto.mealType,
        },
      }),
      this.prisma.planItem.count({
        where: { weeklyPlanId },
      }),
      this.prisma.planItem.findFirst({
        where: {
          weeklyPlanId,
          dayOfWeek: dto.dayOfWeek,
          mealType: dto.mealType,
        },
      }),
    ]);

    if (existingSlot) {
      throw new ConflictException('This day and meal slot is already assigned in weekly plan');
    }

    if (existingForMealType >= WeeklyPlansService.MAX_ITEMS_PER_MEAL_TYPE) {
      throw new BadRequestException('Meal type limit reached (max 7 per week)');
    }

    if (existingTotal >= WeeklyPlansService.MAX_ITEMS_TOTAL) {
      throw new BadRequestException('Weekly plan total limit reached (max 21 items)');
    }

    return this.prisma.planItem.create({
      data: {
        weeklyPlanId,
        recipeId: dto.recipeId,
        dayOfWeek: dto.dayOfWeek,
        mealType: dto.mealType,
      },
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
    return this.prisma.planItem.delete({ where: { id: itemId } });
  }

  async getShoppingList(userId: string, householdId: string, weekStart: string) {
    await this.ensureMembership(userId, householdId);
    const weekStartDate = this.parseWeekStart(weekStart);

    const plan = await this.prisma.weeklyPlan.findUnique({
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
                    department: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!plan) {
      return [];
    }

    const aggregated = new Map<string, ShoppingAccumulator>();
    for (const item of plan.items) {
      for (const ingredient of item.recipe.ingredients) {
        const productKey = this.normalizeProductKey(ingredient.name, ingredient.unit);
        const current = aggregated.get(productKey);
        if (current) {
          current.totalAmount += ingredient.amount;
          continue;
        }
        aggregated.set(productKey, {
          productKey,
          name: ingredient.name,
          unit: ingredient.unit,
          department: ingredient.department,
          totalAmount: ingredient.amount,
        });
      }
    }

    if (aggregated.size === 0) {
      return [];
    }

    const productKeys = Array.from(aggregated.keys());
    const checks = await this.prisma.shoppingItemCheck.findMany({
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
    });
    const checkedMap = new Map(checks.map((check) => [check.productKey, check.isChecked]));

    return Array.from(aggregated.values())
      .map((item) => ({
        ...item,
        totalAmount: Number(item.totalAmount.toFixed(2)),
        isChecked: checkedMap.get(item.productKey) ?? false,
      }))
      .sort((a, b) => {
        if (a.department === b.department) {
          return a.name.localeCompare(b.name);
        }
        return a.department.localeCompare(b.department);
      });
  }

  async setShoppingItemChecked(
    userId: string,
    householdId: string,
    weekStart: string,
    dto: UpdateShoppingItemCheckDto,
  ) {
    await this.ensureMembership(userId, householdId);
    const weekStartDate = this.parseWeekStart(weekStart);

    // Validate that the product exists in current shopping list of the selected week.
    const shoppingItems = await this.getShoppingList(userId, householdId, weekStart);
    const exists = shoppingItems.some((item) => item.productKey === dto.productKey);
    if (!exists) {
      throw new NotFoundException('Shopping item not found for this household and week');
    }

    return this.prisma.shoppingItemCheck.upsert({
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
  }
}
