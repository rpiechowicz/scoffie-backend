import { Module } from '@nestjs/common';
import { RecipesModule } from '../../recipes/recipes.module';
import { AdminCoreModule } from '../admin-core.module';
import { AdminCatalogController } from './admin-catalog.controller';
import { AdminCatalogInsightsService } from './admin-catalog-insights.service';
import { AdminCatalogService } from './admin-catalog.service';

/**
 * Ekran „Katalog” panelu. `RecipesModule` daje `RecipesCacheService` — tę
 * samą instancję, której używa aplikacja, więc wycofanie przepisu czyści
 * cache listy, który widzą telefony.
 */
@Module({
  imports: [AdminCoreModule, RecipesModule],
  controllers: [AdminCatalogController],
  providers: [AdminCatalogService, AdminCatalogInsightsService],
})
export class AdminCatalogModule {}
