import { Controller, Get, Headers, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../auth/current-user-id.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { clientPlatform } from './announcements.rules';
import {
  AnnouncementsService,
  type MeAnnouncementsResponse,
} from './announcements.service';

/** Komunikaty (banery) dla APLIKACJI — tylko aktywne dla tej osoby i platformy. */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me/announcements')
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get()
  @ApiHeader({
    name: 'X-Client-Platform',
    required: false,
    enum: ['ios', 'android'],
    description:
      '`ios` albo `android`. Bez nagłówka platformę rozpoznaje `User-Agent` (URLSession → ios, OkHttp → android).',
  })
  list(
    @CurrentUserId() userId: string,
    @Headers('x-client-platform') platformHeader: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<MeAnnouncementsResponse> {
    return this.announcements.forUser(
      userId,
      clientPlatform(platformHeader, userAgent),
    );
  }
}
