/**
 * Limity throttlera z env — czytane PER ŻĄDANIE (`Resolvable<number>` z
 * `@nestjs/throttler`), nie przy starcie modułu.
 *
 * Tak samo jak `readAgentEnv`: zmiana limitu na Railway nie ma wymagać nowego
 * builda, a e2e (`test/throttling.e2e-spec.ts`) musi móc podkręcić limit w
 * jednym procesie, bez stawiania drugiej aplikacji. Wszystkie limity mają
 * domyślne, więc merge nie potrzebuje ŻADNEJ nowej zmiennej na Railway.
 *
 * Okno jest jedno — minuta. `blockDuration` zostawiamy równy `ttl` (domyślne
 * zachowanie pakietu): po przekroczeniu limitu klient czeka do końca okna.
 */
export const THROTTLE_WINDOW_MS = 60_000;

/** Osobne, dłuższe okno dla logowania do Cookidoo — patrz `IntegrationsController`. */
export const COOKIDOO_CONNECT_WINDOW_MS = 600_000;
export const COOKIDOO_CONNECT_LIMIT = 5;

export const THROTTLE_KEYS = [
  'THROTTLE_DEFAULT_LIMIT',
  'THROTTLE_IP_LIMIT',
  'THROTTLE_AUTH_LIMIT',
  'THROTTLE_AGENT_MESSAGE_LIMIT',
  'THROTTLE_AGENT_POLL_LIMIT',
  'THROTTLE_ADMIN_LIMIT',
  'THROTTLE_ADMIN_AUTH_LIMIT',
  'THROTTLE_ADMIN_CODE_LIMIT',
] as const;

export type ThrottleKey = (typeof THROTTLE_KEYS)[number];

export const THROTTLE_DEFAULTS: Readonly<Record<ThrottleKey, number>> = {
  // Zwykły ruch aplikacji: 120 żądań/min na użytkownika (albo IP, gdy żądanie
  // jest bez tokenu). iOS robi całą domenę po WebSockecie, więc HTTP to dziś
  // logowanie, integracje i asystent — ten limit ma boleć tylko pętlę w kliencie.
  THROTTLE_DEFAULT_LIMIT: 120,
  // Siatka na IP: jeden adres to może być kilka telefonów za NAT-em, stąd wyżej.
  THROTTLE_IP_LIMIT: 300,
  // `/auth/*` per IP — tu bronimy się przed zgadywaniem, nie przed pętlą.
  // e2e `ws-auth` robi 13 dev-loginów w kilka sekund; domyślna musi to przeżyć.
  THROTTLE_AUTH_LIMIT: 20,
  // Asystent: wysyłka wiadomości jest droga (tura woła model), polling tani.
  THROTTLE_AGENT_MESSAGE_LIMIT: 20,
  THROTTLE_AGENT_POLL_LIMIT: 120,
  // Panel admina (`AdminRateLimiter`, liczony PO bramce Access): per admin
  // z sesją — panel odświeża kilka zapytań naraz, więc luźno…
  THROTTLE_ADMIN_LIMIT: 300,
  // …i per adres bez sesji (logowanie) — tu bronimy się przed zgadywaniem;
  // twardą barierą i tak jest blokada po 5 nieudanych próbach.
  THROTTLE_ADMIN_AUTH_LIMIT: 30,
  // …i osobno próby kodu / klucza (logowanie, step-up) per adres z bramki —
  // tania zapora w pamięci przed blokadą w bazie (5 porażek / 15 min).
  THROTTLE_ADMIN_CODE_LIMIT: 10,
};

/**
 * Limit z env albo domyślny. Zła wartość (nie-liczba, ułamek, < 1) jest
 * ignorowana — limit 0 blokowałby wszystko, więc nie jest legalnym „wyłącz”.
 * Wyłączenie throttlera robi się `@SkipThrottle`, nie zerem w env.
 */
export function readThrottleLimit(
  key: ThrottleKey,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = (env[key] ?? '').trim();
  if (!raw) return THROTTLE_DEFAULTS[key];
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return THROTTLE_DEFAULTS[key];
  return parsed;
}

/** Problemy konfiguracji do `assert-env` — te same zasady, co dla `AI_*`. */
export function throttleEnvProblems(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const problems: string[] = [];
  for (const key of THROTTLE_KEYS) {
    const raw = (env[key] ?? '').trim();
    if (!raw) continue;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      problems.push(
        `${key}=${raw} — oczekiwana liczba całkowita ≥ 1 (przy złej wartości działa domyślna ${THROTTLE_DEFAULTS[key]})`,
      );
    }
  }
  const wsRaw = (env.WS_RATE_LIMIT_PER_MIN ?? '').trim();
  if (wsRaw) {
    const parsed = Number(wsRaw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      problems.push(
        `WS_RATE_LIMIT_PER_MIN=${wsRaw} — oczekiwana liczba całkowita ≥ 0 (0 = limiter wyłączony)`,
      );
    }
  }
  return problems;
}
