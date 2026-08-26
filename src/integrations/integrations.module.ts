import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CookidooIntegrationService } from './cookidoo-integration.service';
import { CookidooServiceClient } from './cookidoo-service.client';
import { IntegrationsController } from './integrations.controller';

@Module({
  // AuthModule eksportuje JwtModule (dla JwtAuthGuard); PrismaModule jest @Global.
  imports: [AuthModule],
  controllers: [IntegrationsController],
  providers: [CookidooIntegrationService, CookidooServiceClient],
})
export class IntegrationsModule {}
