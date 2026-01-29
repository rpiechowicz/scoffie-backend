import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateRecipeDto } from './dto/create-recipe.dto';
import { RecipeDto } from './dto/recipe.dto';
import { RecipesService } from './recipes.service';

@ApiTags('recipes')
@Controller('recipes')
@UseGuards(JwtAuthGuard)
export class RecipesController {
  constructor(private readonly recipesService: RecipesService) {}

  @Get()
  @ApiOkResponse({ type: [RecipeDto] })
  findAll(@Req() req: any, @Query('householdId') householdId?: string) {
    return this.recipesService.findAll(req.user.id, householdId);
  }

  @Get(':id')
  @ApiOkResponse({ type: RecipeDto })
  findById(@Req() req: any, @Param('id') id: string) {
    return this.recipesService.findById(req.user.id, id);
  }

  @Post()
  @ApiCreatedResponse({ type: RecipeDto })
  create(@Req() req: any, @Body() dto: CreateRecipeDto) {
    return this.recipesService.create(req.user.id, dto);
  }
}
