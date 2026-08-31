import { Module } from '@nestjs/common';
import { RecipesGateway } from './recipes.gateway';
import { RecipesService } from './recipes.service';
import { RecipesCacheService } from './recipes-cache.service';
import { IngredientsService } from './ingredients.service';

@Module({
  providers: [
    RecipesService,
    RecipesGateway,
    RecipesCacheService,
    IngredientsService,
  ],
  exports: [RecipesCacheService],
})
export class RecipesModule {}
