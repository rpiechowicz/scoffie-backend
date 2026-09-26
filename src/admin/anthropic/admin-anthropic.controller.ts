import {
  Body,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
} from '../admin.decorators';
import { adminActor } from '../audit/admin-audit.service';
import type { ResolvedAdminSession } from '../auth/admin-sessions.service';
import type { AnthropicBilling } from '../contract';
import {
  AdminAnthropicAnchorDto,
  AdminAnthropicSettingsDto,
} from './admin-anthropic.dto';
import { AdminAnthropicService } from './admin-anthropic.service';

/**
 * Kredyty Claude: wydatki z Anthropic (odczyt jak koszty asystenta) i kotwice
 * salda wpisywane ręcznie (zapis jak sterowanie). Kotwica to księgowość
 * panelu, nie ruch pieniędzy — bez step-upu, ale z audytem.
 */
@AdminController('anthropic')
export class AdminAnthropicController {
  constructor(private readonly anthropic: AdminAnthropicService) {}

  @Get()
  @AdminRequires('assistant.read')
  billing(): Promise<AnthropicBilling> {
    return this.anthropic.billing();
  }

  @Post('anchors')
  @AdminRequires('settings.write')
  createAnchor(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Body() dto: AdminAnthropicAnchorDto,
  ): Promise<AnthropicBilling> {
    return this.anthropic.createAnchor(adminActor(session, access), dto);
  }

  @Delete('anchors/:id')
  @AdminRequires('settings.write')
  @HttpCode(HttpStatus.OK)
  deleteAnchor(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Param('id') rawId: string,
  ): Promise<AnthropicBilling> {
    return this.anthropic.deleteAnchor(
      adminActor(session, access),
      assertUuid(rawId, 'id'),
    );
  }

  @Put('settings')
  @AdminRequires('settings.write')
  settings(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Body() dto: AdminAnthropicSettingsDto,
  ): Promise<AnthropicBilling> {
    return this.anthropic.setLowBalance(
      adminActor(session, access),
      dto.lowBalanceUsd,
    );
  }
}
