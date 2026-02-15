import { Module } from '@nestjs/common';
import { RecipesGateway } from './recipes.gateway';
import { RecipesService } from './recipes.service';
import { RecipesCacheService } from './recipes-cache.service';

@Module({
  providers: [RecipesService, RecipesGateway, RecipesCacheService],
  exports: [RecipesCacheService],
})
export class RecipesModule {}
