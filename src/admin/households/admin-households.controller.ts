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
import { adminActor, AdminAuditService } from '../audit/admin-audit.service';
import type { ResolvedAdminSession } from '../auth/admin-sessions.service';
import type { HouseholdDetail, HouseholdListItem } from '../contract';
import { AdminReasonDto, AdminSetTierDto } from './admin-households.dto';
import { AdminHouseholdsService } from './admin-households.service';

/**
 * Gospodarstwa w panelu (ROADMAPA §5.3). Odczyt za `households.read`, akcje
 * na pieniądzach za `billing.write` + świeży step-up — nadanie PRO to
 * darmowy asystent dla całego domu, a reset sufitu zdejmuje bezpiecznik
 * kosztu.
 */
@AdminController('households')
export class AdminHouseholdsController {
  constructor(
    private readonly households: AdminHouseholdsService,
    private readonly audit: AdminAuditService,
  ) {}

  @Get()
  @AdminRequires('households.read')
  list(): Promise<{ total: number; items: HouseholdListItem[] }> {
    return this.households.list();
  }

  @Get(':id')
  @AdminRequires('households.read')
  detail(@Param('id') rawId: string): Promise<HouseholdDetail> {
    return this.households.detail(assertUuid(rawId, 'id'));
  }

  @Post(':id/tier')
  @AdminRequires('billing.write')
  @RequireStepUp()
  @HttpCode(HttpStatus.NO_CONTENT)
  async setTier(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Param('id') rawId: string,
    @Body() dto: AdminSetTierDto,
  ): Promise<void> {
    const id = assertUuid(rawId, 'id');
    await this.audit.run(
      adminActor(session, access),
      {
        action: 'household.tier.set',
        targetType: 'Household',
        targetId: id,
        reason: dto.reason,
        details: { to: dto.tier },
      },
      () => this.households.setTier(id, dto.tier),
      (change) => ({ from: change.from, to: change.to }),
    );
  }

  @Post(':id/cost-reset')
  @AdminRequires('billing.write')
  @RequireStepUp()
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetCost(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Param('id') rawId: string,
    @Body() dto: AdminReasonDto,
  ): Promise<void> {
    const id = assertUuid(rawId, 'id');
    const now = new Date();
    await this.audit.run(
      adminActor(session, access),
      {
        action: 'household.cost.reset',
        targetType: 'Household',
        targetId: id,
        reason: dto.reason,
        details: { periodKey: this.households.costPeriodKey(now) },
      },
      () => this.households.resetCost(id, now),
      (result) => ({ periodKey: result.periodKey, reset: result.reset }),
    );
  }
}
