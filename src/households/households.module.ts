import { Module } from '@nestjs/common';
import { HouseholdsGateway } from './households.gateway';
import { HouseholdsService } from './households.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { MailModule } from '../mail/mail.module';

@Module({
  // Bez tego importu `NotificationsService` nie jest w ogóle rozwiązywalny w
  // tym injektorze — i dlatego dołączenie domownika nigdy nie wysyłało pusha.
  imports: [NotificationsModule, MailModule],
  providers: [HouseholdsService, HouseholdsGateway],
  // Dla narzędzi asystenta (`src/agent/tools`).
  exports: [HouseholdsService],
})
export class HouseholdsModule {}
