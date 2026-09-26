import { Module } from '@nestjs/common';
import { RecipesGateway } from './recipes.gateway';
import { RecipesService } from './recipes.service';
import { RecipesCacheService } from './recipes-cache.service';
import { IngredientsService } from './ingredients.service';
import { CatalogSyncService } from './catalog-sync.service';

@Module({
  providers: [
    RecipesService,
    RecipesGateway,
    RecipesCacheService,
    IngredientsService,
    CatalogSyncService,
  ],
  // Serwisy wystawione dla `src/agent/`: narzędzia asystenta wołają domenę
  // in-process, przez te same metody, co handlery WS.
  exports: [
    RecipesCacheService,
    RecipesService,
    IngredientsService,
    CatalogSyncService,
  ],
})
export class RecipesModule {}
