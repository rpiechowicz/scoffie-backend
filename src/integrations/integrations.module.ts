import { Module } from '@nestjs/common';
import { ObservabilityModule } from '../observability/observability.module';
import { AuthModule } from '../auth/auth.module';
import { ConsentsModule } from '../consents/consents.module';
import { CookidooIntegrationService } from './cookidoo-integration.service';
import { CookidooServiceClient } from './cookidoo-service.client';
import { HealthStepsController } from './health-steps.controller';
import { HealthStepsService } from './health-steps.service';
import { IntegrationsController } from './integrations.controller';

@Module({
  // AuthModule eksportuje JwtModule (dla JwtAuthGuard); PrismaModule jest @Global.
  imports: [AuthModule, ConsentsModule, ObservabilityModule],
  controllers: [IntegrationsController, HealthStepsController],
  providers: [
    CookidooIntegrationService,
    CookidooServiceClient,
    HealthStepsService,
  ],
})
export class IntegrationsModule {}
