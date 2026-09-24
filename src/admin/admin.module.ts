import { Module } from '@nestjs/common';
import { AccessJwtVerifier } from './access/access-jwt.verifier';
import { AdminGuard } from './admin.guard';
import { AdminRateLimiter } from './admin-rate-limiter';

/**
 * Panel administratora — backend (`/admin/*`), plan w
 * `docs/plans/scoffie-admin/ROADMAPA.md`.
 *
 * Moduł JEDNOKIERUNKOWY (ROADMAPA §1.6, pilnuje `no-restricted-imports`):
 * woła domenę i obserwowalność, a nic w aplikacji nie importuje
 * `src/admin/` — rejestruje go wyłącznie `AppModule`.
 *
 * Każdy kontroler panelu stoi za `AdminGuard` (bramka Cloudflare Access,
 * identyczne 404 dla obcych) i ma `@SkipThrottle` — limit liczy się dopiero
 * po bramce (`AdminRateLimiter`).
 */
@Module({
  providers: [AccessJwtVerifier, AdminRateLimiter, AdminGuard],
})
export class AdminModule {}
