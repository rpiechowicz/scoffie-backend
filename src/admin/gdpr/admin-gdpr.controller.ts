import {
  Body,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { assertUuid } from '../../common/uuid';
import { AdminController } from '../admin-controller.decorator';
import type { AdminAccessContext } from '../admin-request';
import {
  AdminAccess,
  AdminRequires,
  CurrentAdminSession,
} from '../admin.decorators';
import { adminActor } from '../audit/admin-audit.service';
import type { ResolvedAdminSession } from '../auth/admin-sessions.service';
import type { GdprData, GdprRequestDetail } from '../contract';
import {
  AdminGdprCloseDto,
  AdminGdprCreateDto,
  AdminGdprExtendDto,
  AdminGdprQueryDto,
  AdminGdprStatusDto,
  AdminGdprUpdateDto,
} from './admin-gdpr.dto';
import { AdminGdprService } from './admin-gdpr.service';

/**
 * Rejestr wniosków RODO (ROADMAPA §5.11). Bez step-upu: rejestr to
 * ewidencja, nie operacja na danych osoby — eksport i usunięcie konta
 * zostają akcjami karty osoby, które step-up mają. Każdy zapis w dzienniku.
 */
@AdminController('gdpr')
export class AdminGdprController {
  constructor(private readonly gdpr: AdminGdprService) {}

  @Get()
  @AdminRequires('gdpr.read')
  list(@Query() query: AdminGdprQueryDto): Promise<GdprData> {
    return this.gdpr.list(query);
  }

  @Get(':id')
  @AdminRequires('gdpr.read')
  detail(@Param('id') rawId: string): Promise<GdprRequestDetail> {
    return this.gdpr.detail(assertUuid(rawId, 'id'));
  }

  @Post()
  @AdminRequires('gdpr.write')
  create(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Body() dto: AdminGdprCreateDto,
  ): Promise<GdprRequestDetail> {
    return this.gdpr.create(adminActor(session, access), dto);
  }

  @Patch(':id')
  @AdminRequires('gdpr.write')
  update(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Param('id') rawId: string,
    @Body() dto: AdminGdprUpdateDto,
  ): Promise<GdprRequestDetail> {
    return this.gdpr.update(
      adminActor(session, access),
      assertUuid(rawId, 'id'),
      dto,
    );
  }

  @Post(':id/status')
  @AdminRequires('gdpr.write')
  @HttpCode(HttpStatus.OK)
  setStatus(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Param('id') rawId: string,
    @Body() dto: AdminGdprStatusDto,
  ): Promise<GdprRequestDetail> {
    return this.gdpr.setStatus(
      adminActor(session, access),
      assertUuid(rawId, 'id'),
      dto.status,
    );
  }

  @Post(':id/extend')
  @AdminRequires('gdpr.write')
  @HttpCode(HttpStatus.OK)
  extend(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Param('id') rawId: string,
    @Body() dto: AdminGdprExtendDto,
  ): Promise<GdprRequestDetail> {
    return this.gdpr.extend(
      adminActor(session, access),
      assertUuid(rawId, 'id'),
      dto.reason,
    );
  }

  @Post(':id/close')
  @AdminRequires('gdpr.write')
  @HttpCode(HttpStatus.OK)
  close(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Param('id') rawId: string,
    @Body() dto: AdminGdprCloseDto,
  ): Promise<GdprRequestDetail> {
    return this.gdpr.close(
      adminActor(session, access),
      assertUuid(rawId, 'id'),
      dto,
    );
  }
}
