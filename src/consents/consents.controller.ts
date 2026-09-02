import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../auth/current-user-id.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ConsentsService } from './consents.service';
import { RecordConsentDto } from './dto/record-consent.dto';

/**
 * Zgody po HTTP z JWT (nie po sockecie): to dowód prawny, więc tożsamość ma
 * pochodzić z tokenu, a zapis ma być prosty do odtworzenia w logach żądań.
 * Odczyt i zapis działają niezależnie od `AI_ENABLED` — cofnięcie zgody nie
 * może zależeć od tego, czy asystent akurat działa.
 */
@ApiTags('consents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me/consents')
export class ConsentsController {
  constructor(private readonly consents: ConsentsService) {}

  @Get()
  status(@CurrentUserId() userId: string) {
    return this.consents.status(userId);
  }

  @Post()
  record(@CurrentUserId() userId: string, @Body() dto: RecordConsentDto) {
    return this.consents.record(userId, dto);
  }
}
