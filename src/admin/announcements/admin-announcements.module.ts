import { Module } from '@nestjs/common';
import { AdminCoreModule } from '../admin-core.module';
import { AdminAnnouncementsController } from './admin-announcements.controller';
import { AdminAnnouncementsService } from './admin-announcements.service';

/** Ekran „Komunikaty”. `AnnouncementsService` (pamięć dla aplikacji) jest globalny. */
@Module({
  imports: [AdminCoreModule],
  controllers: [AdminAnnouncementsController],
  providers: [AdminAnnouncementsService],
})
export class AdminAnnouncementsModule {}
