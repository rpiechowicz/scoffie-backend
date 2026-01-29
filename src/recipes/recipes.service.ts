import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRecipeDto } from './dto/create-recipe.dto';

@Injectable()
export class RecipesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.recipe.findMany({ orderBy: { createdAt: 'desc' } });
  }

  findById(id: string) {
    return this.prisma.recipe.findUnique({ where: { id } });
  }

  create(data: CreateRecipeDto) {
    return this.prisma.recipe.create({ data });
  }
}
