import { Body, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
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
import type { AnnouncementRow, AnnouncementsData } from '../contract';
import { AdminReasonDto } from '../users/admin-users.dto';
import { AdminAnnouncementCreateDto } from './admin-announcements.dto';
import { AdminAnnouncementsService } from './admin-announcements.service';

/** Komunikaty w aplikacji. Publikacja i zakończenie — step-up, powód, audyt. */
@AdminController('announcements')
export class AdminAnnouncementsController {
  constructor(private readonly announcements: AdminAnnouncementsService) {}

  @Get()
  @AdminRequires('announcements.read')
  list(): Promise<AnnouncementsData> {
    return this.announcements.data();
  }

  @Post()
  @AdminRequires('announcements.write')
  @RequireStepUp()
  create(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Body() dto: AdminAnnouncementCreateDto,
  ): Promise<AnnouncementRow> {
    return this.announcements.create(adminActor(session, access), dto);
  }

  @Post(':id/end')
  @AdminRequires('announcements.write')
  @RequireStepUp()
  @HttpCode(HttpStatus.OK)
  end(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Param('id') rawId: string,
    @Body() dto: AdminReasonDto,
  ): Promise<AnnouncementRow> {
    return this.announcements.end(
      adminActor(session, access),
      assertUuid(rawId, 'id'),
      dto.reason,
    );
  }
}
