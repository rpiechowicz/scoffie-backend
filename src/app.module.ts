import { Module } from '@nestjs/common';
import { SentryModule } from '@sentry/nestjs/setup';
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
import { BillingModule } from './billing/billing.module';
import { MailModule } from './mail/mail.module';
import { ConsentsModule } from './consents/consents.module';
import { DataExportModule } from './data-export/data-export.module';
import { AppThrottleModule } from './common/throttle/throttle.module';
import { AdminModule } from './admin/admin.module';
import { RuntimeSettingsModule } from './runtime-settings/runtime-settings.module';

@Module({
  imports: [
    // Kontekst żądania dla błędów w Sentry; bez DSN nic nie robi. Własny
    // filtr wyjątków zostaje — to on decyduje, co jest błędem serwera
    // (`captureUnexpected`), a co zwykłą odpowiedzią 4xx.
    SentryModule.forRoot(),
    PrismaModule,
    // Nadpisania env z panelu (wyłącznik i limity asystenta) — wczytane przy
    // starcie, zanim ruszy pierwsze żądanie do `/agent`.
    RuntimeSettingsModule,
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
    DataExportModule,
    AgentModule,
    BillingModule,
    MailModule,
    // Panel administratora (`/admin/*`) — moduł jednokierunkowy jak asystent:
    // woła domenę, nic go nie importuje. Bez ADMIN_ACCESS_* każda jego trasa
    // odpowiada jak nieistniejąca (404).
    AdminModule,
  ],
})
export class AppModule {}
