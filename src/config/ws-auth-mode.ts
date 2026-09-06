/**
 * Tryb uwierzytelniania WebSocketu (`WS_AUTH_MODE`).
 *
 * - `soft` (domyślny POZA produkcją; na produkcji domyślny jest `strict`):
 *   socket z tokenem w handshake jest
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
  if (raw === 'strict') return 'strict';
  if (raw === 'soft') return 'soft';
  // Brak zmiennej: na produkcji strict (od audytu 3, 3.09.2026 — wszystkie
  // buildy iOS od PR #69 wysyłają token, a `soft` bez tokenu to tożsamość
  // z payloadu). Poza produkcją soft, żeby lokalne narzędzia nie wywracały się.
  return env.NODE_ENV === 'production' ? 'strict' : 'soft';
}

/** Opis problemu z wartością zmiennej albo `null`, gdy jest poprawna/pusta. */
export function wsAuthModeProblem(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = (env.WS_AUTH_MODE ?? '').trim().toLowerCase();
  if (!raw || (WS_AUTH_MODES as readonly string[]).includes(raw)) return null;
  return `WS_AUTH_MODE=${raw} — dozwolone: ${WS_AUTH_MODES.join(', ')} (przy złej wartości działa jak domyślny: strict na produkcji, soft poza nią)`;
}

/**
 * `soft` na produkcji to naruszenie blokujące start — nie ostrzeżenie.
 *
 * W tym trybie socket bez tokenu bierze tożsamość z `payload.userId`, czyli
 * każdy może nadać dowolne zdarzenie (także `users:delete`) w imieniu
 * dowolnego konta, a pokój `legacy` dostaje broadcasty wszystkich gospodarstw.
 * Okno przejściowe skończyło się z buildem iOS z PR #69 (każdy build od
 * 31.08.2026 wysyła token), więc jedyną drogą włączenia `soft` na produkcji
 * była pomyłka przy kopiowaniu `.env.example` na Railway. Poza produkcją
 * `soft` zostaje — lokalne narzędzia (`pnpm ws:smoke`) chodzą bez tokenu.
 */
export function wsAuthModeProductionProblem(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.NODE_ENV !== 'production') return null;
  const raw = (env.WS_AUTH_MODE ?? '').trim().toLowerCase();
  if (raw !== 'soft') return null;
  return 'WS_AUTH_MODE=soft — na produkcji socket bez tokenu podszywa się pod dowolne konto; usuń zmienną albo ustaw strict';
}
