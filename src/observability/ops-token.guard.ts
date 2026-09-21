import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';

export const OPS_TOKEN_HEADER = 'x-ops-token';

/**
 * Bramka na `GET /ops/metrics`: lista tras z licznikami błędów, nazwy
 * migracji, statystyki cache — to mapa serwera, nie sonda żywotności.
 * `/ops/health` zostaje publiczny (Railway/HEALTHCHECK pytają go bez nagłówka).
 *
 * Reguła: nagłówek `x-ops-token` musi równać się `OPS_TOKEN`. Gdy zmiennej
 * nie ma — ODMOWA, w każdym środowisku (fail-closed).
 *
 * AUDYT 21.09.2026. Dawniej pusty `OPS_TOKEN` poza `NODE_ENV=production`
 * wpuszczał każdego. „Poza produkcją" to nie tylko laptop: staging na zdalnej
 * bazie z `NODE_ENV=staging` i zapomnianą zmienną oddawał obcemu
 * `POST /ops/billing/grant`, `POST /ops/households/:id/tier` i odczyt
 * subskrypcji po `userId`. Brak konfiguracji nie może znaczyć „otwarte".
 *
 * Jedyny wyjątek jest jawny i testowy: `NODE_ENV=test` (ustawia go jest),
 * żeby suita uruchomiona bez `OPS_TOKEN` nie wymagała sekretu. Ustawiony
 * token obowiązuje także w testach. Wartości tokenu — ani oczekiwanej, ani
 * przysłanej — nie logujemy i nie oddajemy w treści błędu.
 */
@Injectable()
export class OpsTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = (process.env.OPS_TOKEN ?? '').trim();
    if (!expected) {
      if (process.env.NODE_ENV === 'test') {
        return true;
      }
      throw new ForbiddenException('OPS_TOKEN is not configured');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers[OPS_TOKEN_HEADER];
    const provided = (Array.isArray(header) ? header[0] : header) ?? '';

    if (!OpsTokenGuard.safeEquals(provided.trim(), expected)) {
      throw new ForbiddenException('Invalid ops token');
    }
    return true;
  }

  /** Porównanie w stałym czasie; różna długość = różne tokeny. */
  private static safeEquals(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
