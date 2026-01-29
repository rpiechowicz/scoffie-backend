import { Body, Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CreateRecipeDto } from './dto/create-recipe.dto';
import { RecipeDto } from './dto/recipe.dto';
import { RecipesService } from './recipes.service';

@ApiTags('recipes')
@Controller('recipes')
export class RecipesController {
  constructor(private readonly recipesService: RecipesService) {}

  @Get()
  @ApiOkResponse({ type: [RecipeDto] })
  findAll() {
    return this.recipesService.findAll();
  }

  @Get(':id')
  @ApiOkResponse({ type: RecipeDto })
  async findById(@Param('id') id: string) {
    const recipe = await this.recipesService.findById(id);
    if (!recipe) {
      throw new NotFoundException('Recipe not found');
    }
    return recipe;
  }

  @Post()
  @ApiCreatedResponse({ type: RecipeDto })
  create(@Body() dto: CreateRecipeDto) {
    return this.recipesService.create(dto);
  }
}
