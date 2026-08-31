import { Module } from '@nestjs/common';
import { WeeklyPlansGateway } from './weekly-plans.gateway';
import { WeeklyPlansService } from './weekly-plans.service';
import { ShoppingListService } from './services/shopping-list.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  providers: [ShoppingListService, WeeklyPlansService, WeeklyPlansGateway],
  // Dla narzędzi asystenta (`src/agent/tools`).
  exports: [WeeklyPlansService],
})
export class WeeklyPlansModule {}
