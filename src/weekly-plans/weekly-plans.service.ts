import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePlanItemDto } from './dto/create-plan-item.dto';
import { CreateWeeklyPlanDto } from './dto/create-weekly-plan.dto';

@Injectable()
export class WeeklyPlansService {
  constructor(private readonly prisma: PrismaService) {}

  listByHousehold(householdId: string) {
    return this.prisma.weeklyPlan.findMany({
      where: { householdId },
      orderBy: { weekStart: 'desc' },
      include: { items: true },
    });
  }

  async getByHouseholdAndWeek(householdId: string, weekStart: string) {
    const plan = await this.prisma.weeklyPlan.findUnique({
      where: { householdId_weekStart: { householdId, weekStart: new Date(weekStart) } },
      include: { items: true },
    });
    if (!plan) {
      throw new NotFoundException('Weekly plan not found');
    }
    return plan;
  }

  create(householdId: string, dto: CreateWeeklyPlanDto) {
    return this.prisma.weeklyPlan.create({
      data: {
        householdId,
        weekStart: new Date(dto.weekStart),
      },
    });
  }

  async addItem(weeklyPlanId: string, dto: CreatePlanItemDto) {
    const plan = await this.prisma.weeklyPlan.findUnique({
      where: { id: weeklyPlanId },
    });
    if (!plan) {
      throw new NotFoundException('Weekly plan not found');
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

  removeItem(itemId: string) {
    return this.prisma.planItem.delete({ where: { id: itemId } });
  }
}
