import { Module } from '@nestjs/common';
import { WeeklyPlansGateway } from './weekly-plans.gateway';
import { WeeklyPlansService } from './weekly-plans.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  providers: [WeeklyPlansService, WeeklyPlansGateway],
})
export class WeeklyPlansModule {}
