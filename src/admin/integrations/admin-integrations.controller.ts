import {
  Body,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
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
import type {
  AppStoreState,
  MailData,
  OpsData,
  RailwayLogs,
  RailwayServiceState,
} from '../contract';
import { assertUuid } from '../../common/uuid';
import { AdminReasonDto } from '../users/admin-users.dto';
import {
  AdminMailQueryDto,
  AdminServiceLogsQueryDto,
  AdminServiceQueryDto,
  AdminSuppressDto,
} from './admin-integrations.dto';
import { AdminIntegrationsService } from './admin-integrations.service';
import { AdminMailService } from './admin-mail.service';

/** Poczta (ROADMAPA §5.10). „Ponów” — `POST /admin/mails/:id/retry`. */
@AdminController('mail')
export class AdminMailController {
  constructor(private readonly mail: AdminMailService) {}

  @Get()
  @AdminRequires('mail.read')
  data(@Query() query: AdminMailQueryDto): Promise<MailData> {
    return this.mail.data(query);
  }

  @Post('suppressions')
  @AdminRequires('mail.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async suppress(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Body() dto: AdminSuppressDto,
  ): Promise<void> {
    await this.mail.suppress(
      adminActor(session, access),
      dto.email,
      dto.reason,
    );
  }

  @Delete('suppressions/:email')
  @AdminRequires('mail.write')
  @RequireStepUp()
  @HttpCode(HttpStatus.NO_CONTENT)
  async unsuppress(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Param('email') email: string,
    @Body() dto: AdminReasonDto,
  ): Promise<void> {
    await this.mail.unsuppress(adminActor(session, access), email, dto.reason);
  }
}

/** Stabilność: Sentry + Railway (ROADMAPA §5.9), tylko odczyt. */
@AdminController('ops')
export class AdminOpsController {
  constructor(private readonly integrations: AdminIntegrationsService) {}

  @Get()
  @AdminRequires('ops.read')
  data(): Promise<OpsData> {
    return this.integrations.ops();
  }

  @Get('services/:id')
  @AdminRequires('ops.read')
  service(
    @Param('id') rawId: string,
    @Query() query: AdminServiceQueryDto,
  ): Promise<RailwayServiceState> {
    return this.integrations.service(
      assertUuid(rawId, 'id'),
      query.range ?? '24h',
    );
  }

  @Get('services/:id/logs')
  @AdminRequires('ops.logs')
  logs(
    @Param('id') rawId: string,
    @Query() query: AdminServiceLogsQueryDto,
  ): Promise<RailwayLogs> {
    return this.integrations.logs(assertUuid(rawId, 'id'), {
      deploymentId: query.deployment,
      kind: query.kind ?? 'deploy',
      filter: query.filter,
    });
  }
}

/** App Store Connect: buildy, wersje, recenzje (ROADMAPA §5.9), tylko odczyt. */
@AdminController('app-store')
export class AdminAppStoreController {
  constructor(private readonly integrations: AdminIntegrationsService) {}

  @Get()
  @AdminRequires('appstore.read')
  data(): Promise<AppStoreState> {
    return this.integrations.appStore();
  }
}
