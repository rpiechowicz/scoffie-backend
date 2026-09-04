import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AppStoreServerClient } from './app-store-server.client';
import { BillingController } from './billing.controller';
import { BillingOpsController } from './billing-ops.controller';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionsReconcileService } from './subscriptions-reconcile.service';

/**
 * Płatności App Store.
 *
 * Moduł stoi OBOK modułu asystenta, a nie w nim: subskrypcja jest stanem
 * konta, nie funkcją asystenta. Asystent tylko czyta z niej uprawnienie
 * (`AiUsageCountersService.resolvePlan`) i nie wie nic o Apple.
 */
@Module({
  imports: [PrismaModule],
  controllers: [BillingController, BillingOpsController],
  providers: [
    AppStoreServerClient,
    SubscriptionsService,
    SubscriptionsReconcileService,
  ],
  exports: [SubscriptionsService],
})
export class BillingModule {}
