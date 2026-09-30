import { Module } from '@nestjs/common';
import { RecipesGateway } from './recipes.gateway';
import { RecipesService } from './recipes.service';
import { RecipesCacheService } from './recipes-cache.service';
import { IngredientsService } from './ingredients.service';
import { CatalogSyncService } from './catalog-sync.service';
import { RecipeSharingService } from './sharing/recipe-sharing.service';
import { PublicRecipesController } from './sharing/public-recipes.controller';
import { CookScenariosService } from './cook-scenario/cook-scenarios.service';

@Module({
  controllers: [PublicRecipesController],
  providers: [
    RecipesService,
    RecipesGateway,
    RecipesCacheService,
    IngredientsService,
    CatalogSyncService,
    RecipeSharingService,
    CookScenariosService,
  ],
  // Serwisy wystawione dla `src/agent/`: narzędzia asystenta wołają domenę
  // in-process, przez te same metody, co handlery WS.
  exports: [
    RecipesCacheService,
    RecipesService,
    IngredientsService,
    CatalogSyncService,
    RecipeSharingService,
  ],
})
export class RecipesModule {}
