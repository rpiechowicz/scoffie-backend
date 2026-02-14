import { Module } from '@nestjs/common';
import { NotificationsGateway } from './notifications.gateway';
import { NotificationsService } from './notifications.service';
import { ApnsService } from './apns.service';

@Module({
  providers: [NotificationsGateway, NotificationsService, ApnsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}

