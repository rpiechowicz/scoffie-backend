/**
 * Tryb uwierzytelniania WebSocketu (`WS_AUTH_MODE`).
 *
 * - `soft` (domyślny, gdy zmiennej brak): socket z tokenem w handshake jest
 *   weryfikowany jak w `strict` (zły/wygasły token = odmowa — nowy build iOS
 *   ma dostać prawdziwe zachowanie), socket BEZ tokenu wchodzi jako `legacy`
 *   i bierze tożsamość z `payload.userId` jak dawniej. To okno przejściowe
 *   dla buildów iOS sprzed tokenu w handshake — mierzone w
 *   `/ops/metrics` → `http.wsAuth`, żeby było widać, kiedy legacy spadło do zera.
 * - `strict`: brak tokenu = odmowa handshake'u (`connect_error` z kodem
 *   `UNAUTHORIZED`). Docelowy tryb po adopcji buildu iOS z tokenem.
 *
 * Czytany PER HANDSHAKE (nie przy imporcie), żeby e2e mogło przełączać tryb
 * w jednym procesie i żeby zmiana zmiennej nie wymagała nowego builda.
 * Brak trybu `off`: gdyby adapter miał wywrócić prod, ratunkiem jest rollback
 * deployu, a nie flaga, która przywraca podszywanie się po WS.
 */
export type WsAuthMode = 'soft' | 'strict';

export const WS_AUTH_MODES: readonly WsAuthMode[] = ['soft', 'strict'];

export function resolveWsAuthMode(
  env: NodeJS.ProcessEnv = process.env,
): WsAuthMode {
  const raw = (env.WS_AUTH_MODE ?? '').trim().toLowerCase();
  return raw === 'strict' ? 'strict' : 'soft';
}

/** Opis problemu z wartością zmiennej albo `null`, gdy jest poprawna/pusta. */
export function wsAuthModeProblem(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = (env.WS_AUTH_MODE ?? '').trim().toLowerCase();
  if (!raw || (WS_AUTH_MODES as readonly string[]).includes(raw)) return null;
  return `WS_AUTH_MODE=${raw} — dozwolone: ${WS_AUTH_MODES.join(', ')} (przy złej wartości działa jak soft)`;
}
