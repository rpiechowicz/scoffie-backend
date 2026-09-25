import {
  Body,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { assertUuid } from '../../common/uuid';
import { AdminController } from '../admin-controller.decorator';
import type { AdminAccessContext } from '../admin-request';
import {
  AdminAccess,
  AdminRequires,
  CurrentAdminSession,
  RequireStepUp,
} from '../admin.decorators';
import { adminActor } from '../audit/admin-audit.service';
import type { ResolvedAdminSession } from '../auth/admin-sessions.service';
import type {
  CatalogInsights,
  Ingredient,
  RecipeDetail,
  RecipeListItem,
} from '../contract';
import { AdminCatalogInsightsService } from './admin-catalog-insights.service';
import {
  CatalogRecipesQueryDto,
  RecipeActiveDto,
  UpdateCatalogRecipeDto,
} from './admin-catalog.dto';
import { AdminCatalogService } from './admin-catalog.service';

/** Katalog przepisów i składników (ROADMAPA §5.7). */
@AdminController('catalog')
export class AdminCatalogController {
  constructor(
    private readonly catalog: AdminCatalogService,
    private readonly catalogInsights: AdminCatalogInsightsService,
  ) {}

  /** „Jakość” (luki w danych) i „Popularność” katalogu. */
  @Get('insights')
  @AdminRequires('catalog.read')
  insights(): Promise<CatalogInsights> {
    return this.catalogInsights.insights();
  }

  @Get('recipes')
  @AdminRequires('catalog.read')
  recipes(
    @Query() query: CatalogRecipesQueryDto,
  ): Promise<{ total: number; items: RecipeListItem[] }> {
    return this.catalog.recipes(
      query.active === undefined ? undefined : query.active === 'true',
    );
  }

  @Get('recipes/:id')
  @AdminRequires('catalog.read')
  recipe(@Param('id') rawId: string): Promise<RecipeDetail> {
    return this.catalog.recipe(assertUuid(rawId, 'id'));
  }

  @Get('ingredients')
  @AdminRequires('catalog.read')
  ingredients(): Promise<Ingredient[]> {
    return this.catalog.ingredients();
  }

  /**
   * Edycja przepisu katalogu (D1 zamknięte 25.09.2026: baza jest źródłem
   * prawdy, `recipes-catalog-full-v2.json` — jej eksportem, odświeżanym nocnym
   * PR-em). Zmianę widać od razu u wszystkich użytkowników, stąd step-up
   * (403 `STEP_UP_REQUIRED` w guardzie, przed walidacją ciała). Szczegóły
   * zapisu i kody błędów: `AdminCatalogService.updateRecipe`.
   */
  @Put('recipes/:id')
  @AdminRequires('catalog.publish')
  @RequireStepUp()
  updateRecipe(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Param('id') rawId: string,
    @Body() dto: UpdateCatalogRecipeDto,
  ): Promise<RecipeDetail> {
    return this.catalog.updateRecipe(
      adminActor(session, access),
      assertUuid(rawId, 'id'),
      dto,
    );
  }

  @Post('recipes/:id/active')
  @AdminRequires('catalog.publish')
  @RequireStepUp()
  @HttpCode(HttpStatus.NO_CONTENT)
  async setActive(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Param('id') rawId: string,
    @Body() dto: RecipeActiveDto,
  ): Promise<void> {
    await this.catalog.setActive(
      adminActor(session, access),
      assertUuid(rawId, 'id'),
      dto.isActive,
      dto.reason,
    );
  }
}
