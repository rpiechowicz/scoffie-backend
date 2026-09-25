import { Module } from '@nestjs/common';
import { BillingModule } from '../../billing/billing.module';
import { AdminCoreModule } from '../admin-core.module';
import { AdminSubscriptionsController } from './admin-subscriptions.controller';
import { AdminSubscriptionsService } from './admin-subscriptions.service';

/**
 * Ekran „Subskrypcje" panelu. `BillingModule` eksportuje `SubscriptionsService`
 * — ponowienie powiadomienia idzie jego `processNotification`, nie kopią.
 */
@Module({
  imports: [AdminCoreModule, BillingModule],
  controllers: [AdminSubscriptionsController],
  providers: [AdminSubscriptionsService],
})
export class AdminSubscriptionsModule {}
