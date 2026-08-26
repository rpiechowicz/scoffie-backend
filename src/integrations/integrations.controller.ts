import { Body, Controller, Delete, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CookidooIntegrationService } from './cookidoo-integration.service';
import { CurrentUserId } from './current-user-id.decorator';
import { ConnectCookidooDto } from './dto/connect-cookidoo.dto';
import { SendToWeekDto } from './dto/send-to-week.dto';

// Integracje jadą po HTTP z JWT, nie po Socket.IO — gatewaye ufają `userId`
// z payloadu, co przy poświadczeniach Cookidoo jest nie do przyjęcia.
@ApiTags('integrations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('integrations/cookidoo')
export class IntegrationsController {
  constructor(
    private readonly cookidooIntegration: CookidooIntegrationService,
  ) {}

  @Post('connect')
  connect(@CurrentUserId() userId: string, @Body() dto: ConnectCookidooDto) {
    return this.cookidooIntegration.connect(userId, dto.email, dto.password);
  }

  @Get('status')
  status(@CurrentUserId() userId: string) {
    return this.cookidooIntegration.status(userId);
  }

  @Delete()
  disconnect(@CurrentUserId() userId: string) {
    return this.cookidooIntegration.disconnect(userId);
  }

  @Post('send-to-week')
  sendToWeek(@CurrentUserId() userId: string, @Body() dto: SendToWeekDto) {
    return this.cookidooIntegration.sendToWeek(userId, dto.recipeId, dto.date);
  }
}
