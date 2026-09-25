import { Module } from '@nestjs/common';
import { AdminCoreModule } from './admin-core.module';
import { AdminAssistantModule } from './assistant/admin-assistant.module';
import { AdminCatalogModule } from './catalog/admin-catalog.module';
import {
  AdminAuthController,
  AdminSessionController,
} from './auth/admin-auth.controller';
import { AdminAuthService } from './auth/admin-auth.service';
import { AdminHouseholdsModule } from './households/admin-households.module';
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
 */
@Module({
  imports: [
    AdminCoreModule,
    AdminUsersModule,
    AdminHouseholdsModule,
    AdminSubscriptionsModule,
    AdminAssistantModule,
    AdminCatalogModule,
  ],
  controllers: [AdminAuthController, AdminSessionController],
  providers: [AdminAuthService],
})
export class AdminModule {}
