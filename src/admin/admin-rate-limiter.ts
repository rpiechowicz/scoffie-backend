import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../common/app-exception';

export const ADMIN_RATE_WINDOW_MS = 60_000;

/** Powyżej tylu śledzonych kluczy robimy przegląd mapy. */
const MAX_TRACKED = 2_000;

/**
 * Osobny limiter panelu — przesuwane okno minuty, w pamięci procesu.
 *
 * DLACZEGO NIE GLOBALNY `AppThrottlerGuard`. Globalny guard biegnie PRZED
 * bramką panelu, więc skaner bez tokenu Access dostawałby na `/admin/users`
 * 429 po stu żądaniach — a na nieistniejącej trasie nigdy (trasy, których nie
 * ma, w ogóle nie przechodzą przez guardy). To zdradzałoby, które ścieżki
 * istnieją. Kontrolery panelu mają więc `@SkipThrottle`, a ten limiter liczy
 * dopiero PO bramce: po `admin:<id>` z sesją, po `ip:<adres>` bez niej
 * (logowanie). Obcy dostaje wyłącznie 404.
 */
@Injectable()
export class AdminRateLimiter {
  private readonly hits = new Map<string, number[]>();

  check(key: string, limit: number, now: number = Date.now()): void {
    if (limit <= 0) return;
    if (this.hits.size > MAX_TRACKED) this.prune(now);

    const fresh = (this.hits.get(key) ?? []).filter(
      (at) => now - at < ADMIN_RATE_WINDOW_MS,
    );
    if (fresh.length >= limit) {
      this.hits.set(key, fresh);
      const oldest = fresh[0] ?? now;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((ADMIN_RATE_WINDOW_MS - (now - oldest)) / 1000),
      );
      throw new AppException(
        'TOO_MANY_REQUESTS',
        'Za dużo żądań. Spróbuj ponownie za chwilę.',
        HttpStatus.TOO_MANY_REQUESTS,
        [`retryAfterSeconds:${retryAfterSeconds}`],
      );
    }
    fresh.push(now);
    this.hits.set(key, fresh);
  }

  reset(): void {
    this.hits.clear();
  }

  private prune(now: number): void {
    for (const [key, stamps] of this.hits) {
      const fresh = stamps.filter((at) => now - at < ADMIN_RATE_WINDOW_MS);
      if (fresh.length === 0) this.hits.delete(key);
      else this.hits.set(key, fresh);
    }
  }
}
