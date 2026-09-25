import {
  Body,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { assertUuid } from '../../common/uuid';
import type { UserExport } from '../../data-export/user-export';
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
import type { HealthData, UserDetail, UserList } from '../contract';
import { AdminMailsService } from './admin-mails.service';
import { AdminReasonDto, AdminUserListQueryDto } from './admin-users.dto';
import { AdminUsersService } from './admin-users.service';

/**
 * Użytkownicy: lista, karta osoby i akcje na koncie. Akcje, które bolą
 * (dane o zdrowiu, eksport, usunięcie konta), wymagają świeżego step-upu —
 * guard odrzuca je 403 `STEP_UP_REQUIRED` przed walidacją ciała.
 */
@AdminController('users')
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  @AdminRequires('users.read')
  list(@Query() query: AdminUserListQueryDto): Promise<UserList> {
    return this.users.list(query);
  }

  @Get(':id')
  @AdminRequires('users.read')
  detail(@Param('id') rawId: string): Promise<UserDetail> {
    return this.users.detail(assertUuid(rawId, 'id'));
  }

  @Post(':id/health')
  @AdminRequires('users.health.reveal')
  @RequireStepUp()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  revealHealth(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Param('id') rawId: string,
    @Body() dto: AdminReasonDto,
  ): Promise<HealthData> {
    return this.users.revealHealth(
      adminActor(session, access),
      assertUuid(rawId, 'id'),
      dto.reason,
    );
  }

  @Post(':id/logout-everywhere')
  @AdminRequires('users.sessions.write')
  @HttpCode(HttpStatus.OK)
  logoutEverywhere(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Param('id') rawId: string,
  ): Promise<{ closed: number }> {
    return this.users.logoutEverywhere(
      adminActor(session, access),
      assertUuid(rawId, 'id'),
    );
  }

  /** Paczka RODO wraca w odpowiedzi jako plik — patrz `AdminUsersService.exportData`. */
  @Post(':id/export')
  @AdminRequires('users.export')
  @RequireStepUp()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async exportData(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Param('id') rawId: string,
    @Body() dto: AdminReasonDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UserExport> {
    const id = assertUuid(rawId, 'id');
    const bundle = await this.users.exportData(
      adminActor(session, access),
      id,
      dto.reason,
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="scoffie-dane-${id}.json"`,
    );
    return bundle;
  }

  @Delete(':id')
  @AdminRequires('users.delete')
  @RequireStepUp()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Param('id') rawId: string,
    @Body() dto: AdminReasonDto,
  ): Promise<void> {
    await this.users.deleteAccount(
      adminActor(session, access),
      assertUuid(rawId, 'id'),
      dto.reason,
    );
  }
}

/** `POST /admin/mails/:id/retry` — mail FAILED wraca do kolejki. */
@AdminController('mails')
export class AdminMailsController {
  constructor(private readonly mails: AdminMailsService) {}

  @Post(':id/retry')
  @AdminRequires('mail.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async retry(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Param('id') rawId: string,
  ): Promise<void> {
    await this.mails.retry(
      adminActor(session, access),
      assertUuid(rawId, 'id'),
    );
  }
}
