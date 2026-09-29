import { Body, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { AdminController } from '../admin-controller.decorator';
import type { AdminAccessContext } from '../admin-request';
import {
  AdminAccess,
  AdminRequires,
  CurrentAdminSession,
} from '../admin.decorators';
import { adminActor } from '../audit/admin-audit.service';
import type { ResolvedAdminSession } from '../auth/admin-sessions.service';
import type { RecipeShareRevokeResult } from '../contract';
import { RevokeRecipeShareDto } from './admin-catalog.dto';
import { AdminCatalogService } from './admin-catalog.service';

/**
 * Moderacja linków do przepisów gospodarstw (udostępnianie, 29.09.2026).
 * Bez step-upu: wyłączenie linku niczego nie odsłania ani nie niszczy —
 * to akcja ochronna po zgłoszeniu treści (DSA: zgłoszenie → reakcja).
 */
@AdminController('recipe-shares')
export class AdminRecipeSharesController {
  constructor(private readonly catalog: AdminCatalogService) {}

  @Post('revoke')
  @AdminRequires('catalog.publish')
  @HttpCode(HttpStatus.OK)
  revoke(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Body() dto: RevokeRecipeShareDto,
  ): Promise<RecipeShareRevokeResult> {
    return this.catalog.revokeShare(
      adminActor(session, access),
      dto.link,
      dto.reason,
    );
  }
}
