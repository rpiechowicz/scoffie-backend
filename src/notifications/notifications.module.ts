import { Module } from '@nestjs/common';
import { NotificationsGateway } from './notifications.gateway';
import { NotificationsService } from './notifications.service';
import { ApnsService } from './apns.service';

@Module({
  providers: [NotificationsGateway, NotificationsService, ApnsService],
  // `ApnsService` — panel administratora pokazuje środowisko APNs urządzeń,
  // które go nie podały, tak jak liczy je wysyłka (`defaultEnvironment`).
  exports: [NotificationsService, ApnsService],
})
export class NotificationsModule {}
