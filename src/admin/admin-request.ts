import { NotFoundException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { readAdminProxySecret } from '../config/admin-env';
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
   * `CF-Connecting-IP` od Workera panelu (tylko z `X-Admin-Proxy-Secret`),
   * a bez niego adres połączenia. Do wglądu i do licznika blokady —
   * tożsamość i tak wiąże JWT bramki.
   */
  ip: string | null;
  /**
   * `CF-IPCountry` (dwuliterowy kod kraju z brzegu Cloudflare) — tylko od
   * Workera z sekretem, inaczej `null`.
   */
  country: string | null;
  userAgent: string | null;
  requestId: string | null;
};

export type AdminRequest = Request & {
  /**
   * Wynik bramki Access policzony RAZ na żądanie (`AdminGate.pass`) — przez
   * middleware na prefiksie `/admin`, także dla tras, których nie ma.
   */
  adminGate?: Promise<AdminAccessContext | null>;
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

/** Nagłówek, którym Worker panelu dowodzi, że to on przekazuje żądanie. */
export const ADMIN_PROXY_SECRET_HEADER = 'x-admin-proxy-secret';

const sha256 = (value: string): Buffer =>
  createHash('sha256').update(value, 'utf8').digest();

/**
 * Czy żądanie przyszło przez Workera panelu: `X-Admin-Proxy-Secret` równy
 * `ADMIN_PROXY_SECRET`. Porównanie stałoczasowe na haszach (równa długość,
 * więc `timingSafeEqual` nie rzuca i nie zdradza długości sekretu).
 */
export function fromAdminProxy(
  req: Request,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const secret = readAdminProxySecret(env);
  if (!secret) return false;
  const presented = header(req, ADMIN_PROXY_SECRET_HEADER);
  if (!presented) return false;
  return timingSafeEqual(sha256(presented), sha256(secret));
}

/**
 * Kontekst żądania do zapisu — bez tożsamości, tę dokłada bramka.
 *
 * `CF-Connecting-IP` i `CF-IPCountry` przyjmujemy WYŁĄCZNIE od Workera
 * z sekretem (`fromAdminProxy`): `api.scoffie.app` jest DNS-only, więc bez
 * tego każdy, kto ma token Access, podawałby dowolne IP — i rotacją adresu
 * omijał licznik blokady per IP. Bez sekretu: adres połączenia (`req.ip`,
 * `trust proxy` = 1 hop Railwaya) i brak kraju.
 */
export function describeAdminRequest(
  req: AdminRequest,
): Omit<AdminAccessContext, 'email' | 'subject' | 'via'> {
  const trusted = fromAdminProxy(req);
  const country = trusted ? header(req, 'cf-ipcountry') : null;
  return {
    ip: (trusted ? header(req, 'cf-connecting-ip') : null) ?? req.ip ?? null,
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
