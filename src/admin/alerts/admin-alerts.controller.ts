import {
  Body,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { IsIn, IsOptional, Matches } from 'class-validator';
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
  AlertsData,
  DailyReportPreview,
  DailyReportSendResult,
} from '../contract';
import { AdminAlertsService } from './admin-alerts.service';
import { AdminDailyReportService } from './admin-daily-report.service';

export class AdminAlertsQueryDto {
  @IsOptional()
  @IsIn(['open', 'all'])
  state?: 'open' | 'all';
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class AdminReportDayDto {
  @IsOptional()
  @Matches(DAY)
  date?: string;
}

/** Centrum alertów. `state=open` — tylko otwarte (licznik w menu). */
@AdminController('alerts')
export class AdminAlertsController {
  constructor(private readonly alerts: AdminAlertsService) {}

  @Get()
  @AdminRequires('alerts.read')
  data(@Query() query: AdminAlertsQueryDto): Promise<AlertsData> {
    return this.alerts.data(query.state ?? 'all');
  }

  @Post(':id/ack')
  @AdminRequires('alerts.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async ack(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Param('id') rawId: string,
  ): Promise<void> {
    await this.alerts.ack(adminActor(session, access), assertUuid(rawId, 'id'));
  }
}

/** Raport „Scoffie wczoraj”: podgląd i wysyłka na żądanie. */
@AdminController('reports/daily')
export class AdminDailyReportController {
  constructor(private readonly report: AdminDailyReportService) {}

  @Get('preview')
  @AdminRequires('daily-report.read')
  preview(@Query() query: AdminReportDayDto): Promise<DailyReportPreview> {
    return this.report.preview(query.date);
  }

  @Post('send')
  @AdminRequires('daily-report.send')
  @RequireStepUp()
  send(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Body() dto: AdminReportDayDto,
  ): Promise<DailyReportSendResult> {
    return this.report.send(adminActor(session, access), dto.date);
  }
}
