import { HttpStatus } from '@nestjs/common';
import { AppException } from './app-exception';

/**
 * Limit żądań na WebSockecie — per użytkownik, przesuwane okno minuty.
 *
 * Osobny mechanizm od `AppThrottlerGuard`, bo globalny guard Nesta nie
 * obsługuje gatewayów tak, jak trzeba: rzut z guardu omija ack (klient czeka
 * 3×6 s zamiast dostać błąd), a `context.switchToHttp()` nie ma tu `req.ip`.
 * Dlatego limiter jest zwykłą funkcją wołaną WEWNĄTRZ `actorId`, czyli już po
 * ustaleniu tożsamości i w środku `wsRespond` — błąd wraca ackiem jako
 * `TOO_MANY_REQUESTS` z `details: ['retryAfterSeconds:n']`, tak samo jak po HTTP.
 *
 * Stan trzymany w pamięci procesu; to wystarcza, bo na Railway chodzi jedna
 * instancja (patrz analiza asystenta, „Jedna instancja"). `WS_RATE_LIMIT_PER_MIN=0`
 * wyłącza limiter, wartość czytana per wywołanie — jak reszta limitów.
 */
export const WS_RATE_LIMIT_WINDOW_MS = 60_000;
export const WS_RATE_LIMIT_DEFAULT = 120;

/** Powyżej tylu śledzonych użytkowników robimy przegląd mapy (patrz `prune`). */
const MAX_TRACKED_ACTORS = 5_000;

const hits = new Map<string, number[]>();

export function readWsRateLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.WS_RATE_LIMIT_PER_MIN ?? '').trim();
  if (!raw) return WS_RATE_LIMIT_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return WS_RATE_LIMIT_DEFAULT;
  return parsed;
}

function prune(now: number): void {
  for (const [key, stamps] of hits) {
    const fresh = stamps.filter((at) => now - at < WS_RATE_LIMIT_WINDOW_MS);
    if (fresh.length === 0) {
      hits.delete(key);
    } else {
      hits.set(key, fresh);
    }
  }
}

/**
 * Odnotowuje jedno wywołanie handlera przez `userId`; po przekroczeniu limitu
 * rzuca `TOO_MANY_REQUESTS`. Rzut ZAMIAST zapisu — odrzucone wywołanie nie
 * przedłuża blokady, więc klient odzyskuje dostęp dokładnie po minucie od
 * pierwszego zliczonego żądania.
 */
export function checkWsRateLimit(
  userId: string,
  now: number = Date.now(),
): void {
  const limit = readWsRateLimit();
  if (limit <= 0) return;

  // Mapa rośnie tylko o użytkowników, którzy naprawdę coś robią, ale sockety
  // przychodzą i odchodzą — bez przeglądu wpisy zostałyby na zawsze.
  if (hits.size > MAX_TRACKED_ACTORS) prune(now);

  const fresh = (hits.get(userId) ?? []).filter(
    (at) => now - at < WS_RATE_LIMIT_WINDOW_MS,
  );

  if (fresh.length >= limit) {
    hits.set(userId, fresh);
    const oldest = fresh[0] ?? now;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((WS_RATE_LIMIT_WINDOW_MS - (now - oldest)) / 1000),
    );
    throw new AppException(
      'TOO_MANY_REQUESTS',
      'Za dużo żądań. Spróbuj ponownie za chwilę.',
      HttpStatus.TOO_MANY_REQUESTS,
      [`retryAfterSeconds:${retryAfterSeconds}`],
    );
  }

  fresh.push(now);
  hits.set(userId, fresh);
}

/**
 * Czyści stan limitera. Wołane w `buildGateway` (harness specek WS): tabele
 * złych payloadów robią ~200 wywołań jednym userem, więc bez resetu limiter
 * zatrzymywałby własne testy.
 */
export function resetWsRateLimits(): void {
  hits.clear();
}
