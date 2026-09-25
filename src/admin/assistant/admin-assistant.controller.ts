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
import type { AgentReport, ProfitData } from '../contract';
import { ProfitQueryDto, ReportStatusDto } from './admin-assistant.dto';
import { AdminProfitService } from './admin-profit.service';
import { AdminReportsService } from './admin-reports.service';
import type { ReportScenarioResult } from './report-scenario';

/**
 * Asystent w panelu: rentowność (ROADMAPA §5.4) i zgłoszenia odpowiedzi
 * (§5.5). Odczyty — `assistant.read`; decyzje o zgłoszeniach — `reports.write`.
 */
@AdminController('assistant')
export class AdminAssistantController {
  constructor(
    private readonly profitService: AdminProfitService,
    private readonly reports: AdminReportsService,
  ) {}

  @Get('profit')
  @AdminRequires('assistant.read')
  profit(@Query() query: ProfitQueryDto): Promise<ProfitData> {
    return this.profitService.profit(query.period ?? '30');
  }

  @Get('reports')
  @AdminRequires('assistant.read')
  listReports(): Promise<AgentReport[]> {
    return this.reports.list();
  }

  @Patch('reports/:id')
  @AdminRequires('reports.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async setReportStatus(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Param('id') rawId: string,
    @Body() dto: ReportStatusDto,
  ): Promise<void> {
    await this.reports.setStatus(
      adminActor(session, access),
      assertUuid(rawId, 'id'),
      dto.status,
    );
  }

  /**
   * 200, nie 201: nic nie powstaje w bazie — panel oddaje szkic scenariusza
   * do wklejenia w repo (produkcja nie ma gita).
   */
  @Post('reports/:id/scenario')
  @AdminRequires('reports.write')
  @HttpCode(HttpStatus.OK)
  reportScenario(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Param('id') rawId: string,
  ): Promise<ReportScenarioResult> {
    return this.reports.scenario(
      adminActor(session, access),
      assertUuid(rawId, 'id'),
    );
  }
}
