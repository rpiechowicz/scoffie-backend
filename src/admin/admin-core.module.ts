import { Module } from '@nestjs/common';
import { ObservabilityModule } from '../observability/observability.module';
import { AccessJwtVerifier } from './access/access-jwt.verifier';
import { AdminGate, AdminGateMiddleware } from './admin-gate';
import { AdminGuard } from './admin.guard';
import { AdminRateLimiter } from './admin-rate-limiter';
import { AdminAuditService } from './audit/admin-audit.service';
import { AdminLockoutService } from './auth/admin-lockout.service';
import { AdminSessionsService } from './auth/admin-sessions.service';
import { AdminWebAuthnService } from './auth/admin-webauthn.service';

/**
 * Wspólne klocki panelu: bramka (`AdminGuard` z zależnościami), sesje,
 * blokada, passkeye, dziennik audytu.
 *
 * Osobny moduł, bo guard z `@UseGuards` buduje się w module, który deklaruje
 * kontroler — każdy moduł ekranu panelu (użytkownicy, gospodarstwa, …)
 * importuje więc TEN moduł i dostaje te same instancje (limiter trzyma stan
 * w pamięci, więc musi być jeden na proces).
 */
@Module({
  imports: [ObservabilityModule],
  providers: [
    AccessJwtVerifier,
    AdminGate,
    AdminGateMiddleware,
    AdminRateLimiter,
    AdminGuard,
    AdminSessionsService,
    AdminLockoutService,
    AdminWebAuthnService,
    AdminAuditService,
  ],
  exports: [
    ObservabilityModule,
    AccessJwtVerifier,
    AdminGate,
    AdminGateMiddleware,
    AdminRateLimiter,
    AdminGuard,
    AdminSessionsService,
    AdminLockoutService,
    AdminWebAuthnService,
    AdminAuditService,
  ],
})
export class AdminCoreModule {}
