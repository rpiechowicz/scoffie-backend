import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../auth/current-user-id.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  FeatureFlagsService,
  type MeFlagsResponse,
} from './feature-flags.service';

/**
 * Flagi funkcji dla APLIKACJI (nie panelu): tylko wynik dla domu osoby
 * z JWT — bez listy domów, rolloutu ani nadpisań. Po HTTP jak `/me/consents`,
 * żeby klient pobierał je tym samym `BackendRESTCore` przy starcie.
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me/flags')
export class FeatureFlagsController {
  constructor(private readonly flags: FeatureFlagsService) {}

  @Get()
  list(@CurrentUserId() userId: string): Promise<MeFlagsResponse> {
    return this.flags.forUser(userId);
  }
}
