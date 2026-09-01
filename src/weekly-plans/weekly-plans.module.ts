import { Module } from '@nestjs/common';
import { WeeklyPlansGateway } from './weekly-plans.gateway';
import { WeeklyPlansService } from './weekly-plans.service';
import { ShoppingListService } from './services/shopping-list.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  providers: [ShoppingListService, WeeklyPlansService, WeeklyPlansGateway],
  // Dla narzędzi asystenta (`src/agent/tools`). Gateway wychodzi tylko po to,
  // żeby zapis wywołany kliknięciem w karcie rozgłaszał się tak samo jak zapis
  // z aplikacji — inaczej drugi telefon w domu nie wie o zmianie.
  exports: [WeeklyPlansService, WeeklyPlansGateway],
})
export class WeeklyPlansModule {}
