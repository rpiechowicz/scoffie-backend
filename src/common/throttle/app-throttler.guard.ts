import { ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
} from '@nestjs/throttler';
// `import type`: `isolatedModules` + `emitDecoratorMetadata` nie pozwalają
// użyć w sygnaturze z dekoratorem typu zaimportowanego jako wartość.
import type {
  ThrottlerLimitDetail,
  ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';
import { parseBearer } from '../../auth/access-token.service';
import { RequestMetricsService } from '../../observability/request-metrics.service';
import { AppException } from '../app-exception';

type ThrottledRequest = {
  ip?: string;
  method?: string;
  path?: string;
  originalUrl?: string;
  route?: { path?: string };
  headers?: Record<string, string | string[] | undefined>;
};

/**
 * Globalny throttler HTTP.
 *
 * Trzy rzeczy odróżniają go od `ThrottlerGuard` z pakietu:
 *
 * 1. **Tracker per użytkownik, nie per IP.** Globalny guard biegnie PRZED
 *    `JwtAuthGuard`, więc `request.user` jeszcze nie istnieje — tożsamość
 *    trzeba wyciągnąć samemu. Token jest przy tym WERYFIKOWANY
 *    (`verifyAsync`: podpis + `exp`), a nie dekodowany: inaczej ktokolwiek
 *    podrobiłby `sub` i dostał świeży limit na każde żądanie. Bez bazy —
 *    limit to nie autoryzacja, a `AccessTokenService.verify` dokłada zapytanie
 *    o usera do KAŻDEGO żądania, też odrzuconego. Token nieważny → limit po IP.
 * 2. **Odpowiedź w kontrakcie aplikacji.** `ThrottlerException` wychodziłaby
 *    jako `HTTP_ERROR`; tu jest `TOO_MANY_REQUESTS` z `details:
 *    ['retryAfterSeconds:n']` — iOS ma kod, po którym decyduje, i liczbę,
 *    po której ponawia.
 * 3. **Metryki.** 429 z guardu nie dociera do `RequestLoggingInterceptor`
 *    (interceptory biegną po guardach), więc `/ops/metrics` nie widziałby ich
 *    wcale — stąd jawne `recordThrottled`.
 *
 * Konteksty nie-HTTP (gatewaye) są pomijane: guard omija ack. Limit na
 * WebSockecie robi `checkWsRateLimit` w `actorId` (`src/common/ws-rate-limit.ts`).
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly metrics: RequestMetricsService,
  ) {
    super(options, storageService, reflector);
  }

  protected shouldSkip(context: ExecutionContext): Promise<boolean> {
    return Promise.resolve(context.getType() !== 'http');
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    const request = req as ThrottledRequest;
    const token = parseBearer(request.headers?.['authorization']);
    if (token) {
      try {
        const payload = await this.jwtService.verifyAsync<{ sub?: unknown }>(
          token,
        );
        const sub = typeof payload.sub === 'string' ? payload.sub.trim() : '';
        if (sub) return `user:${sub}`;
      } catch {
        // Podrobiony albo wygasły token — liczy się jak żądanie anonimowe.
      }
    }
    return `ip:${request.ip ?? 'unknown'}`;
  }

  protected throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const request = context.switchToHttp().getRequest<ThrottledRequest>();
    const routeKey = `${request.method ?? 'UNKNOWN'} ${
      request.route?.path ?? request.path ?? request.originalUrl ?? '/'
    }`;
    this.metrics.recordThrottled(routeKey);

    // `timeToBlockExpire`/`timeToExpire` są w sekundach (tą samą liczbę pakiet
    // wkłada w nagłówek `Retry-After`); zaokrąglamy w górę i nigdy nie dajemy 0.
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(detail.timeToBlockExpire || detail.timeToExpire || 1),
    );
    // `Promise.reject`, a nie `throw`: bazowy guard robi `await` na tej
    // metodzie, a odrzucona obietnica jest tym, co deklaruje jej sygnatura.
    return Promise.reject(
      new AppException(
        'TOO_MANY_REQUESTS',
        'Za dużo żądań. Spróbuj ponownie za chwilę.',
        HttpStatus.TOO_MANY_REQUESTS,
        [`retryAfterSeconds:${retryAfterSeconds}`],
      ),
    );
  }
}
