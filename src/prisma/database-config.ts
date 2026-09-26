import { cpus } from 'os';

/**
 * Parametry puli i timeoutów bazy — JAWNIE, bez zgadywania (workstream,
 * Etap 4D).
 *
 * Prisma bierze pulę z parametrów `DATABASE_URL` (`connection_limit`,
 * `pool_timeout`, `connect_timeout`); bez nich: `connection_limit` =
 * 2 × CPU + 1, `pool_timeout` 10 s, `connect_timeout` 5 s. Produkcja
 * (Railway) ma `DATABASE_URL` jako referencję do usługi Postgres BEZ tych
 * parametrów, więc liczba połączeń zależy dziś od liczby rdzeni kontenera.
 * Limitu `max_connections` bazy produkcyjnej nie znamy z repo — NIE
 * wpisujemy go tutaj. Sposób ustawienia opisuje raport 04 (§ pula).
 *
 * Transakcje interaktywne (`$transaction(async tx => …)`) mają w Prismie
 * `timeout` 5 s i `maxWait` 2 s. `runSerializable` może je nadpisać
 * zmiennymi `DB_SERIALIZABLE_TIMEOUT_MS` / `DB_SERIALIZABLE_MAX_WAIT_MS`;
 * puste = domyślne Prismy (bez zmiany zachowania).
 */
export type DatabasePoolSettings = {
  connectionLimit: number | null;
  poolTimeoutSeconds: number | null;
  connectTimeoutSeconds: number | null;
  /** Co Prisma przyjmie, gdy parametru brak. */
  defaults: {
    connectionLimit: number;
    poolTimeoutSeconds: number;
    connectTimeoutSeconds: number;
  };
  /** Parametry podane, ale nie liczbą dodatnią — Prisma by je zignorowała albo padła. */
  invalid: string[];
};

const positiveInt = (raw: string | null): number | null | 'invalid' => {
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : 'invalid';
};

export function readDatabasePoolSettings(
  databaseUrl: string | undefined = process.env.DATABASE_URL,
  cpuCount: number = cpus().length,
): DatabasePoolSettings {
  const defaults = {
    connectionLimit: cpuCount * 2 + 1,
    poolTimeoutSeconds: 10,
    connectTimeoutSeconds: 5,
  };
  const invalid: string[] = [];
  let params: URLSearchParams;
  try {
    params = new URL(databaseUrl ?? '').searchParams;
  } catch {
    params = new URLSearchParams();
  }
  const read = (name: string): number | null => {
    const value = positiveInt(params.get(name));
    if (value === 'invalid') {
      invalid.push(name);
      return null;
    }
    return value;
  };
  return {
    connectionLimit: read('connection_limit'),
    poolTimeoutSeconds: read('pool_timeout'),
    connectTimeoutSeconds: read('connect_timeout'),
    defaults,
    invalid,
  };
}

/** Linia do logu startu — bez hosta, użytkownika i hasła. */
export function describeDatabasePool(settings: DatabasePoolSettings): string {
  const part = (
    name: string,
    value: number | null,
    fallback: number,
    unit = '',
  ) =>
    value === null
      ? `${name}=domyślne(${fallback}${unit})`
      : `${name}=${value}${unit}`;
  return [
    part(
      'connection_limit',
      settings.connectionLimit,
      settings.defaults.connectionLimit,
    ),
    part(
      'pool_timeout',
      settings.poolTimeoutSeconds,
      settings.defaults.poolTimeoutSeconds,
      ' s',
    ),
    part(
      'connect_timeout',
      settings.connectTimeoutSeconds,
      settings.defaults.connectTimeoutSeconds,
      ' s',
    ),
    ...(settings.invalid.length > 0
      ? [`NIEPOPRAWNE: ${settings.invalid.join(', ')}`]
      : []),
  ].join(', ');
}

/** Opcje transakcji SERIALIZABLE z env; puste = domyślne Prismy. */
export function serializableTransactionOptions(
  env: NodeJS.ProcessEnv = process.env,
): { timeout?: number; maxWait?: number } {
  const read = (name: string): number | undefined => {
    const raw = (env[name] ?? '').trim();
    if (!raw) return undefined;
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : undefined;
  };
  const timeout = read('DB_SERIALIZABLE_TIMEOUT_MS');
  const maxWait = read('DB_SERIALIZABLE_MAX_WAIT_MS');
  return {
    ...(timeout !== undefined ? { timeout } : {}),
    ...(maxWait !== undefined ? { maxWait } : {}),
  };
}
