import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AppStoreServerClient } from './app-store-server.client';
import { MailModule } from '../mail/mail.module';
import { BillingController } from './billing.controller';
import { BillingOpsController } from './billing-ops.controller';
import { BillingPreflightService } from './billing-preflight.service';
import { PurchaseIdentityGuardService } from './purchase-identity-guard.service';
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
  // AuthModule dostarcza AccessTokenService dla JwtAuthGuard na kontrolerze;
  // bez niego Nest nie zbuduje guarda w zakresie tego modułu i aplikacja
  // pada przy starcie (UnknownDependenciesException).
  imports: [AuthModule, PrismaModule, MailModule],
  controllers: [BillingController, BillingOpsController],
  providers: [
    AppStoreServerClient,
    SubscriptionsService,
    SubscriptionsReconcileService,
    PurchaseIdentityGuardService,
    BillingPreflightService,
  ],
  exports: [SubscriptionsService],
})
export class BillingModule {}
