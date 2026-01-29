import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePlanItemDto } from './dto/create-plan-item.dto';
import { CreateWeeklyPlanDto } from './dto/create-weekly-plan.dto';

@Injectable()
export class WeeklyPlansService {
  constructor(private readonly prisma: PrismaService) {}

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
}
