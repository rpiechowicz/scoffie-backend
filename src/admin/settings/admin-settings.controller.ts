import {
  Body,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
} from '@nestjs/common';
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
import type { RuntimeSettingsData } from '../contract';
import { AdminReasonDto } from '../users/admin-users.dto';
import { AdminRuntimeSettingDto } from './admin-settings.dto';
import { AdminSettingsService } from './admin-settings.service';

/** Sterowanie w locie (ROADMAPA §5.12). Zapis i powrót do env — step-up. */
@AdminController('settings')
export class AdminSettingsController {
  constructor(private readonly settings: AdminSettingsService) {}

  @Get()
  @AdminRequires('settings.read')
  data(): Promise<RuntimeSettingsData> {
    return this.settings.data();
  }

  @Put(':key')
  @AdminRequires('settings.write')
  @RequireStepUp()
  @HttpCode(HttpStatus.NO_CONTENT)
  async set(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Param('key') key: string,
    @Body() dto: AdminRuntimeSettingDto,
  ): Promise<void> {
    await this.settings.set(
      adminActor(session, access),
      key,
      dto.value,
      dto.reason,
    );
  }

  @Delete(':key')
  @AdminRequires('settings.write')
  @RequireStepUp()
  @HttpCode(HttpStatus.NO_CONTENT)
  async clear(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Param('key') key: string,
    @Body() dto: AdminReasonDto,
  ): Promise<void> {
    await this.settings.clear(adminActor(session, access), key, dto.reason);
  }
}
