import {
  Body,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
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
import type { FeatureFlagsData, HouseholdFlagsData } from '../contract';
import { AdminReasonDto } from '../users/admin-users.dto';
import {
  AdminFeatureFlagCreateDto,
  AdminFeatureFlagUpdateDto,
  AdminHouseholdFlagOverrideDto,
} from './admin-flags.dto';
import { AdminFlagsService } from './admin-flags.service';

/** Flagi funkcji (bety) per dom. Każdy zapis — step-up, powód, audyt. */
@AdminController('flags')
export class AdminFlagsController {
  constructor(private readonly flags: AdminFlagsService) {}

  @Get()
  @AdminRequires('flags.read')
  list(): Promise<FeatureFlagsData> {
    return this.flags.data();
  }

  @Get('households/:householdId')
  @AdminRequires('flags.read')
  household(@Param('householdId') rawId: string): Promise<HouseholdFlagsData> {
    return this.flags.household(assertUuid(rawId, 'householdId'));
  }

  @Post()
  @AdminRequires('flags.write')
  @RequireStepUp()
  @HttpCode(HttpStatus.NO_CONTENT)
  async create(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Body() dto: AdminFeatureFlagCreateDto,
  ): Promise<void> {
    await this.flags.create(adminActor(session, access), dto);
  }

  @Patch(':key')
  @AdminRequires('flags.write')
  @RequireStepUp()
  @HttpCode(HttpStatus.NO_CONTENT)
  async update(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Param('key') key: string,
    @Body() dto: AdminFeatureFlagUpdateDto,
  ): Promise<void> {
    await this.flags.update(adminActor(session, access), key, dto);
  }

  @Delete(':key')
  @AdminRequires('flags.write')
  @RequireStepUp()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Param('key') key: string,
    @Body() dto: AdminReasonDto,
  ): Promise<void> {
    await this.flags.remove(adminActor(session, access), key, dto.reason);
  }

  @Put(':key/households/:householdId')
  @AdminRequires('flags.write')
  @RequireStepUp()
  @HttpCode(HttpStatus.NO_CONTENT)
  async setOverride(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Param('key') key: string,
    @Param('householdId') rawId: string,
    @Body() dto: AdminHouseholdFlagOverrideDto,
  ): Promise<void> {
    await this.flags.setOverride(
      adminActor(session, access),
      key,
      assertUuid(rawId, 'householdId'),
      dto.enabled,
      dto.reason,
    );
  }

  @Delete(':key/households/:householdId')
  @AdminRequires('flags.write')
  @RequireStepUp()
  @HttpCode(HttpStatus.NO_CONTENT)
  async clearOverride(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Param('key') key: string,
    @Param('householdId') rawId: string,
    @Body() dto: AdminReasonDto,
  ): Promise<void> {
    await this.flags.clearOverride(
      adminActor(session, access),
      key,
      assertUuid(rawId, 'householdId'),
      dto.reason,
    );
  }
}
