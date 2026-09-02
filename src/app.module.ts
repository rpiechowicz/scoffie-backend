import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { RecipesModule } from './recipes/recipes.module';
import { HouseholdsModule } from './households/households.module';
import { WeeklyPlansModule } from './weekly-plans/weekly-plans.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ObservabilityModule } from './observability/observability.module';
import { CommonModule } from './common/common.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { AgentModule } from './agent/agent.module';
import { ConsentsModule } from './consents/consents.module';
import { AppThrottleModule } from './common/throttle/throttle.module';

@Module({
  imports: [
    PrismaModule,
    CommonModule,
    // Globalny throttler HTTP — rejestruje APP_GUARD, więc musi być w drzewie
    // przed kontrolerami, które ogranicza.
    AppThrottleModule,
    UsersModule,
    AuthModule,
    RecipesModule,
    HouseholdsModule,
    WeeklyPlansModule,
    NotificationsModule,
    ObservabilityModule,
    IntegrationsModule,
    ConsentsModule,
    AgentModule,
  ],
})
export class AppModule {}
