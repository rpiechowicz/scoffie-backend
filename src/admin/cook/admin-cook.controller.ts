import { Body, Get, Param, Post, Query } from '@nestjs/common';
import { assertUuid } from '../../common/uuid';
import type { AdminAccessContext } from '../admin-request';
import type { ResolvedAdminSession } from '../auth/admin-sessions.service';
import { adminActor } from '../audit/admin-audit.service';
import { AdminController } from '../admin-controller.decorator';
import {
  AdminAccess,
  AdminRequires,
  CurrentAdminSession,
  RequireStepUp,
} from '../admin.decorators';
import {
  PublishCookScenarioDto,
  WithdrawCookScenarioDto,
} from './admin-cook.dto';
import { AdminCookScenariosService } from './admin-cook-scenarios.service';
import { FeedbackQueryDto } from '../assistant/admin-assistant.dto';
import type {
  CookFeedbackData,
  CookScenarioDetail,
  CookScenarioListData,
} from '../contract';
import { AdminCookFeedbackService } from './admin-cook-feedback.service';

/**
 * Gotuj w panelu (3.10.2026): oceny gotowania i scenariusze przepisów
 * (E3c). Odczyt — `catalog.read`; publikacja i wycofanie — `catalog.publish`
 * ze step-upem, jak edycja przepisu.
 */
@AdminController('cook')
export class AdminCookController {
  constructor(
    private readonly feedback: AdminCookFeedbackService,
    private readonly scenarios: AdminCookScenariosService,
  ) {}

  /** Stan trybu Gotuj wszystkich przepisów katalogu. */
  @Get('scenarios')
  @AdminRequires('catalog.read')
  scenarioList(): Promise<CookScenarioListData> {
    return this.scenarios.list();
  }

  /** Przepis, wersje scenariusza, treść i walidatory na bieżącym przepisie. */
  @Get('scenarios/:recipeId')
  @AdminRequires('catalog.read')
  scenarioDetail(
    @Param('recipeId') rawId: string,
  ): Promise<CookScenarioDetail> {
    return this.scenarios.detail(assertUuid(rawId, 'recipeId'));
  }

  /**
   * Publikacja (po edycji albo ponowna po zmianie przepisu) — zmienia Gotuj
   * u wszystkich użytkowników, stąd step-up jak przy edycji przepisu.
   */
  @Post('scenarios/:recipeId/publish')
  @AdminRequires('catalog.publish')
  @RequireStepUp()
  publishScenario(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Param('recipeId') rawId: string,
    @Body() dto: PublishCookScenarioDto,
  ): Promise<CookScenarioDetail> {
    return this.scenarios.publish(
      adminActor(session, access),
      assertUuid(rawId, 'recipeId'),
      dto,
    );
  }

  /** Wycofanie — telefony chowają „Gotuj” przy tym przepisie. */
  @Post('scenarios/:recipeId/withdraw')
  @AdminRequires('catalog.publish')
  @RequireStepUp()
  withdrawScenario(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Param('recipeId') rawId: string,
    @Body() dto: WithdrawCookScenarioDto,
  ): Promise<CookScenarioDetail> {
    return this.scenarios.withdraw(
      adminActor(session, access),
      assertUuid(rawId, 'recipeId'),
      dto.reason.trim(),
    );
  }

  /** Oceny gotowania — zakładka „Gotuj” w dziale „Oceny”. */
  @Get('feedback')
  @AdminRequires('catalog.read')
  feedbackOverview(
    @Query() query: FeedbackQueryDto,
  ): Promise<CookFeedbackData> {
    return this.feedback.overview(query.period ?? '30');
  }
}
