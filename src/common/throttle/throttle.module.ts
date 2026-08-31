import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from '../../auth/auth.module';
import { ObservabilityModule } from '../../observability/observability.module';
import { AppThrottlerGuard } from './app-throttler.guard';
import { readThrottleLimit, THROTTLE_WINDOW_MS } from './throttle-env';

/**
 * Dwa liczniki na każde żądanie HTTP:
 *
 * - `default` — per użytkownik (albo per IP, gdy żądanie jest bez tokenu);
 *   to jego nadpisują `@Throttle` na kontrolerach (`/auth/*`, asystent,
 *   logowanie do Cookidoo).
 * - `ip` — twarda siatka na adres, której `@Throttle({ default: … })` nie
 *   rusza. Bez niej ktoś bez tokenu i tak miałby limit po IP, ale kontroler
 *   z luźniejszym `@Throttle` otwierałby całą aplikację.
 *
 * Limity są funkcjami, nie liczbami: `Resolvable<number>` z pakietu jest
 * wołane per żądanie, więc `THROTTLE_*` czyta się z env na bieżąco
 * (patrz `throttle-env.ts`). `ttl` zostaje liczbą — pakiet sortuje po nim
 * throttlery przy starcie.
 *
 * Guard jest `APP_GUARD` rejestrowanym TUTAJ, a nie w `AppModule`: potrzebuje
 * `JwtService` (z `AuthModule`) i `RequestMetricsService`, a globalny provider
 * rozwiązuje zależności w kontekście modułu, w którym go zadeklarowano.
 */
@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [
        {
          name: 'default',
          ttl: THROTTLE_WINDOW_MS,
          limit: () => readThrottleLimit('THROTTLE_DEFAULT_LIMIT'),
        },
        {
          name: 'ip',
          ttl: THROTTLE_WINDOW_MS,
          limit: () => readThrottleLimit('THROTTLE_IP_LIMIT'),
          getTracker: (req: Record<string, any>) =>
            `ip:${(req as { ip?: string }).ip ?? 'unknown'}`,
        },
      ],
    }),
    AuthModule,
    ObservabilityModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: AppThrottlerGuard }],
})
export class AppThrottleModule {}
