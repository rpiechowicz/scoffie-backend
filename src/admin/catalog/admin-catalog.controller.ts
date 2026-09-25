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
import { AdminAuthException } from '../auth/admin-auth.errors';
import type { ResolvedAdminSession } from '../auth/admin-sessions.service';
import type { Ingredient, RecipeDetail, RecipeListItem } from '../contract';
import { CatalogRecipesQueryDto, RecipeActiveDto } from './admin-catalog.dto';
import { AdminCatalogService } from './admin-catalog.service';

/** Katalog przepisów i składników (ROADMAPA §5.7). */
@AdminController('catalog')
export class AdminCatalogController {
  constructor(private readonly catalog: AdminCatalogService) {}

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
   * Edycja przepisu katalogu — ZABLOKOWANA do decyzji D1 (ROADMAPA §9).
   *
   * Źródłem prawdy katalogu jest dziś `prisma/catalog/recipes-catalog-full-v2.json`
   * + import, który przy każdym przebiegu nadpisuje treść przepisu z pliku.
   * Zapis z panelu prosto do bazy zniknąłby więc po cichu przy następnym
   * imporcie — gorzej niż jawna odmowa. Trasa istnieje (panel ma już edytor),
   * odpowiada zawsze 403 `NOT_ALLOWED` i niczego nie dotyka: bez ciała (żadnej
   * walidacji, która zamieniłaby odmowę w 400) i bez step-upu (potwierdzenie
   * tożsamości przed akcją, która i tak się nie wykona, to pusty rytuał).
   */
  @Put('recipes/:id')
  @AdminRequires('catalog.publish')
  updateRecipe(): never {
    throw new AdminAuthException(
      'NOT_ALLOWED',
      'Edycja katalogu czeka na decyzję D1 (źródło prawdy: JSON z importem czy baza) — zmiana zapisana w bazie zniknęłaby przy następnym imporcie.',
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
