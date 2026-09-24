import { Module } from '@nestjs/common';
import { ObservabilityModule } from '../observability/observability.module';
import { AccessJwtVerifier } from './access/access-jwt.verifier';
import { AdminGuard } from './admin.guard';
import { AdminRateLimiter } from './admin-rate-limiter';
import { AdminAuditService } from './audit/admin-audit.service';
import {
  AdminAuthController,
  AdminSessionController,
} from './auth/admin-auth.controller';
import { AdminAuthService } from './auth/admin-auth.service';
import { AdminLockoutService } from './auth/admin-lockout.service';
import { AdminSessionsService } from './auth/admin-sessions.service';
import { AdminWebAuthnService } from './auth/admin-webauthn.service';

/**
 * Panel administratora — backend (`/admin/*`), plan w
 * `docs/plans/scoffie-admin/ROADMAPA.md`, logowanie w `API-AUTH.md`.
 *
 * Moduł JEDNOKIERUNKOWY (ROADMAPA §1.6, pilnuje `no-restricted-imports`):
 * woła domenę i obserwowalność, a nic w aplikacji nie importuje
 * `src/admin/` — rejestruje go wyłącznie `AppModule`.
 *
 * Każdy kontroler panelu powstaje przez `@AdminController` (bramka Access,
 * sesja, uprawnienia, step-up, identyczne 404 dla obcych, limit po bramce).
 */
@Module({
  imports: [ObservabilityModule],
  controllers: [AdminAuthController, AdminSessionController],
  providers: [
    AccessJwtVerifier,
    AdminRateLimiter,
    AdminGuard,
    AdminSessionsService,
    AdminLockoutService,
    AdminWebAuthnService,
    AdminAuditService,
    AdminAuthService,
  ],
})
export class AdminModule {}
