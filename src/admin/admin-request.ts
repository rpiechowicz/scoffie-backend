import { NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import type { ResolvedAdminSession } from './auth/admin-sessions.service';

/**
 * Kontekst żądania, które przeszło bramkę Access. Wszystko, co panel zapisuje
 * o żądaniu (sesje, próby logowania, dziennik audytu), bierze się stąd.
 */
export type AdminAccessContext = {
  /** Adres z bramki (albo z obejścia deweloperskiego), małymi literami. */
  email: string;
  /** `sub` z tokenu Access; `null` przy obejściu deweloperskim. */
  subject: string | null;
  /** Skąd tożsamość: prawdziwa bramka czy lokalne obejście. */
  via: 'access' | 'dev';
  /**
   * `CF-Connecting-IP` od Workera panelu, a bez niego adres połączenia.
   * Do wglądu i do licznika blokady — tożsamość i tak wiąże JWT bramki.
   */
  ip: string | null;
  /** `CF-IPCountry` (dwuliterowy kod kraju z brzegu Cloudflare). */
  country: string | null;
  userAgent: string | null;
  requestId: string | null;
};

export type AdminRequest = Request & {
  adminAccess?: AdminAccessContext;
  /** Sesja panelu po bramce; `null` = brak (trasy `none` / `optional`). */
  adminSession?: ResolvedAdminSession | null;
  requestId?: string;
};

const header = (req: Request, name: string): string | null => {
  const value = req.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = (first ?? '').trim();
  return trimmed || null;
};

export function requestHeader(req: Request, name: string): string | null {
  return header(req, name);
}

/** Kontekst żądania do zapisu — bez tożsamości, tę dokłada bramka. */
export function describeAdminRequest(
  req: AdminRequest,
): Omit<AdminAccessContext, 'email' | 'subject' | 'via'> {
  const country = header(req, 'cf-ipcountry');
  return {
    ip: header(req, 'cf-connecting-ip') ?? req.ip ?? null,
    // `XX` = Cloudflare nie zna kraju, `T1` = Tor — oba zostają, bo mówią coś
    // o tym, skąd przyszło logowanie.
    country: country ? country.slice(0, 8).toUpperCase() : null,
    userAgent: header(req, 'user-agent')?.slice(0, 400) ?? null,
    requestId: req.requestId ?? header(req, 'x-request-id'),
  };
}

/**
 * 404 NIE DO ODRÓŻNIENIA od prawdziwego braku trasy (ROADMAPA §3.4).
 *
 * Nest odpowiada na nieznaną trasę wyjątkiem `NotFoundException` z treścią
 * `Cannot <METODA> <originalUrl>` (`RoutesResolver.registerNotFoundHandler`),
 * który przechodzi przez TEN SAM globalny filtr (`AppExceptionFilter`). Rzut
 * dokładnie takiego wyjątku z guarda daje więc bajt w bajt to samo ciało
 * (`{ code: 'NOT_FOUND', message, requestId }`) i te same nagłówki — ktoś,
 * kto zgadnie `api.scoffie.app/admin/users` z pominięciem bramki, nie odróżni
 * go od `/admin/cokolwiek`. Test: `test/admin-panel.e2e-spec.ts`.
 */
export function hiddenNotFound(req: Request): NotFoundException {
  return new NotFoundException(`Cannot ${req.method} ${req.originalUrl}`);
}
