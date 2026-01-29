import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRecipeDto } from './dto/create-recipe.dto';

@Injectable()
export class RecipesService {
  constructor(private readonly prisma: PrismaService) {}

  private async ensureMembership(userId: string, householdId: string) {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_householdId: { userId, householdId } },
    });
    if (!membership) {
      throw new ForbiddenException('User is not a member of this household');
    }
  }

  async findAll(userId: string, householdId?: string) {
    if (householdId) {
      await this.ensureMembership(userId, householdId);
      return this.prisma.recipe.findMany({
        where: { householdId },
        orderBy: { createdAt: 'desc' },
      });
    }

    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      select: { householdId: true },
    });
    const householdIds = memberships.map((m) => m.householdId);

    return this.prisma.recipe.findMany({
      where: { householdId: { in: householdIds } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(userId: string, id: string) {
    const recipe = await this.prisma.recipe.findUnique({ where: { id } });
    if (!recipe) {
      throw new NotFoundException('Recipe not found');
    }
    await this.ensureMembership(userId, recipe.householdId);
    return recipe;
  }

  async create(userId: string, data: CreateRecipeDto) {
    await this.ensureMembership(userId, data.householdId);
    return this.prisma.recipe.create({
      data: {
        title: data.title,
        description: data.description,
        householdId: data.householdId,
        authorId: userId,
      },
    });
  }
}
