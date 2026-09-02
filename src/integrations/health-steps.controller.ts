import {
  Body,
  Controller,
  Delete,
  Get,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUserId } from './current-user-id.decorator';
import { HealthStepsRangeDto } from './dto/health-steps-range.dto';
import { SyncHealthStepsDto } from './dto/sync-health-steps.dto';
import { HealthStepsService } from './health-steps.service';

// REST + JWT jak Cookidoo — kroki to dane zdrowotne jednej osoby, więc
// tożsamość musi pochodzić z tokenu, nie z payloadu (patrz komentarz
// w integrations.controller.ts).
@ApiTags('integrations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('integrations/health')
export class HealthStepsController {
  constructor(private readonly healthSteps: HealthStepsService) {}

  // PUT, nie POST: pełny, idempotentny zapis kroczącego okna — ta sama paczka
  // wysłana dwa razy zostawia bazę w identycznym stanie.
  @Put('steps')
  sync(@CurrentUserId() userId: string, @Body() dto: SyncHealthStepsDto) {
    return this.healthSteps.syncSteps(userId, dto.entries);
  }

  @Get('steps')
  list(@CurrentUserId() userId: string, @Query() query: HealthStepsRangeDto) {
    return this.healthSteps.getSteps(userId, query.from, query.to);
  }

  /**
   * Wyłączenie synchronizacji w aplikacji kasuje kopię na serwerze —
   * polityka §10: kroki „przez czas korzystania z integracji". Dotąd jedyną
   * drogą było usunięcie konta.
   */
  @Delete('steps')
  clear(@CurrentUserId() userId: string) {
    return this.healthSteps.deleteAll(userId);
  }
}
