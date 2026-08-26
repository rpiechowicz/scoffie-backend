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

@Module({
  imports: [
    PrismaModule,
    CommonModule,
    UsersModule,
    AuthModule,
    RecipesModule,
    HouseholdsModule,
    WeeklyPlansModule,
    NotificationsModule,
    ObservabilityModule,
    IntegrationsModule,
  ],
})
export class AppModule {}
