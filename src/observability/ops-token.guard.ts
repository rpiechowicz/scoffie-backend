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
 * nie ma — poza produkcją wpuszczamy (dev, CI), na produkcji odmawiamy
 * zawsze (a `assert-env.ts` i tak nie pozwoli wystartować bez niej).
 */
@Injectable()
export class OpsTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = (process.env.OPS_TOKEN ?? '').trim();
    if (!expected) {
      if (process.env.NODE_ENV === 'production') {
        throw new ForbiddenException('OPS_TOKEN is not configured');
      }
      return true;
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
