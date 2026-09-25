import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { AdminCoreModule } from './admin-core.module';
import { AdminGateMiddleware } from './admin-gate';
import { AdminAuditModule } from './audit/admin-audit.module';
import { AdminAlertsModule } from './alerts/admin-alerts.module';
import { AdminAssistantModule } from './assistant/admin-assistant.module';
import { AdminCatalogModule } from './catalog/admin-catalog.module';
import { AdminGdprModule } from './gdpr/admin-gdpr.module';
import { AdminDatabaseModule } from './database/admin-database.module';
import { AdminTrafficModule } from './traffic/admin-traffic.module';
import {
  AdminAuthController,
  AdminSessionController,
} from './auth/admin-auth.controller';
import { AdminAuthService } from './auth/admin-auth.service';
import { AdminGrowthModule } from './growth/admin-growth.module';
import { AdminHouseholdsModule } from './households/admin-households.module';
import { AdminRevenueModule } from './revenue/admin-revenue.module';
import { AdminSettingsModule } from './settings/admin-settings.module';
import { AdminIntegrationsModule } from './integrations/admin-integrations.module';
import { AdminSubscriptionsModule } from './subscriptions/admin-subscriptions.module';
import { AdminUsersModule } from './users/admin-users.module';

/**
 * Panel administratora — backend (`/admin/*`), plan w
 * `docs/plans/scoffie-admin/ROADMAPA.md`, logowanie w `API-AUTH.md`.
 *
 * Moduł JEDNOKIERUNKOWY (ROADMAPA §1.6, pilnuje `no-restricted-imports`):
 * woła domenę i obserwowalność, a nic w aplikacji nie importuje
 * `src/admin/` — rejestruje go wyłącznie `AppModule`.
 *
 * Każdy kontroler panelu powstaje przez `@AdminController` (bramka Access,
 * sesja, uprawnienia, step-up, identyczne 404 dla obcych, limit po bramce),
 * a każdy moduł ekranu importuje `AdminCoreModule`.
 *
 * `AdminGateMiddleware` weryfikuje token Access na CAŁYM prefiksie `/admin`,
 * także na ścieżkach, których nie ma — czas odpowiedzi nie zdradza, które
 * trasy istnieją (szczegóły w `admin-gate.ts`).
 */
@Module({
  imports: [
    AdminCoreModule,
    AdminUsersModule,
    AdminHouseholdsModule,
    AdminSubscriptionsModule,
    AdminAssistantModule,
    AdminCatalogModule,
    AdminIntegrationsModule,
    AdminAuditModule,
    AdminSettingsModule,
    AdminAlertsModule,
    AdminGrowthModule,
    AdminGdprModule,
    AdminRevenueModule,
    AdminDatabaseModule,
    AdminTrafficModule,
  ],
  controllers: [AdminAuthController, AdminSessionController],
  providers: [AdminAuthService],
})
export class AdminModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(AdminGateMiddleware)
      .forRoutes(
        { path: 'admin', method: RequestMethod.ALL },
        { path: 'admin/*path', method: RequestMethod.ALL },
      );
  }
}
