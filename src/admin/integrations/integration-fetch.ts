import { Logger } from '@nestjs/common';
import type { IntegrationState } from '../contract';

const logger = new Logger('AdminIntegrations');

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Błąd dostawcy w formie do pokazania w panelu: kto, kod HTTP, skrót
 * odpowiedzi. Nigdy nagłówki ani token.
 */
export class IntegrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationError';
  }
}

/**
 * `fetch` z limitem czasu i JSON-em. Integracje panelu to zwykłe `fetch`
 * bez SDK — jak `ResendMailClient` i `OpsAlertService`: kilka GET-ów nie
 * uzasadnia zależności z własnym cyklem wydań.
 */
export async function fetchJson<T>(
  provider: string,
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ body: T; headers: Headers }> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new IntegrationError(
      `${provider} nie odpowiada (${error instanceof Error ? error.name : 'sieć'})`,
    );
  }
  if (!res.ok) {
    const snippet = (await res.text().catch(() => '')).slice(0, 200).trim();
    const hint =
      res.status === 401 || res.status === 403
        ? ' — klucz odrzucony albo bez uprawnień'
        : '';
    throw new IntegrationError(
      `${provider}: HTTP ${res.status}${hint}${snippet ? ` · ${snippet}` : ''}`,
    );
  }
  return { body: (await res.json()) as T, headers: res.headers };
}

/**
 * Klucz `.p8` wklejony do Railwaya: z nagłówkami, z `\n` zamiast łamań albo
 * sam base64 — jak `APPLE_BILLING_PRIVATE_KEY` w `billing-env.ts`.
 */
export function normalizePrivateKey(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (!value) return '';
  const withNewlines = value.replace(/\\n/g, '\n');
  if (withNewlines.includes('BEGIN')) return withNewlines;
  const body = withNewlines
    .replace(/\s+/g, '')
    .match(/.{1,64}/g)
    ?.join('\n');
  return body
    ? `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`
    : '';
}

const MAX_CACHE_ENTRIES = 500;

type CacheEntry = {
  at: number;
  value: Promise<IntegrationState<unknown>>;
  /** wynik po rozstrzygnięciu obietnicy — do trybu „ostatni znany stan” */
  settled?: IntegrationState<unknown>;
  /** trwa odświeżanie w tle (najwyżej jedno na klucz) */
  refreshing?: boolean;
};

/** Pełny odczyt spoza pamięci (np. przebieg alertów) — do zasiania pustego klucza. */
export type IntegrationSeed<T> = { data: T; at: number } | null | undefined;

/**
 * Pamięć odpowiedzi na kilkadziesiąt sekund: panel odświeża się co minutę,
 * a limity API dostawców (Sentry, ASC) są niskie. Równoległe żądania dostają
 * tę samą obietnicę — jedno wywołanie dostawcy na okno. Błąd też zostaje
 * zapamiętany na okno, żeby padnięty dostawca nie dostawał serii ponowień.
 *
 * Tabela `IntegrationSnapshot` z roadmapy (§6) będzie potrzebna dopiero
 * dla historii; na pulpit wystarcza pamięć procesu.
 */
export class IntegrationCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  get<T>(
    key: string,
    ttlMs: number,
    load: () => Promise<T>,
  ): Promise<IntegrationState<T>> {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < ttlMs) {
      return hit.value as Promise<IntegrationState<T>>;
    }
    const value = toState(load);
    this.put(key, { at: this.now(), value });
    return value;
  }

  /**
   * Ostatni znany stan (stale-while-revalidate): przeterminowany, ale udany
   * odczyt wraca od razu, a świeży pobiera się w tle — najwyżej jeden naraz
   * na klucz. Nieudane odświeżenie zostawia stary odczyt (`fetchedAt` dalej
   * mówi, z kiedy jest) i następna próba idzie dopiero po `ttlMs`. Pusty klucz
   * można zasiać odczytem spoza pamięci (`seed`); bez niego — czekamy jak
   * w `get`. `onRefresh` — tylko gdy odświeżenie w tle przyniosło inne dane.
   */
  getOrStale<T>(
    key: string,
    ttlMs: number,
    load: () => Promise<T>,
    options: {
      seed?: IntegrationSeed<T>;
      onRefresh?: (next: IntegrationState<T>) => void;
    } = {},
  ): Promise<IntegrationState<T>> {
    let hit = this.entries.get(key);
    if (!hit && options.seed) {
      const state: IntegrationState<T> = {
        status: 'ok',
        data: options.seed.data,
        fetchedAt: new Date(options.seed.at).toISOString(),
      };
      hit = {
        at: options.seed.at,
        value: Promise.resolve(state),
        settled: state,
      };
      this.put(key, hit);
    }
    if (!hit) return this.get(key, ttlMs, load);
    if (this.now() - hit.at < ttlMs) {
      return hit.value as Promise<IntegrationState<T>>;
    }
    // W toku pierwsze pobranie — czekamy na nie; poprzedni błąd — pytamy od nowa.
    if (!hit.settled) return hit.value as Promise<IntegrationState<T>>;
    if (hit.settled.status !== 'ok') return this.get(key, ttlMs, load);
    const entry = hit;
    if (!entry.refreshing) {
      entry.refreshing = true;
      const previous = entry.settled as IntegrationState<T> & { status: 'ok' };
      void toState(load).then((next) => {
        entry.refreshing = false;
        if (this.entries.get(key) !== entry) return;
        if (next.status !== 'ok') {
          // Dostawca nie odpowiada — stary odczyt zostaje, próba za `ttlMs`.
          entry.at = this.now();
          return;
        }
        this.put(key, {
          at: this.now(),
          value: Promise.resolve(next),
          settled: next,
        });
        if (JSON.stringify(next.data) !== JSON.stringify(previous.data)) {
          options.onRefresh?.(next);
        }
      });
    }
    return entry.value as Promise<IntegrationState<T>>;
  }

  private put(key: string, entry: CacheEntry): void {
    // Klucze per osoba (błędy Sentry na karcie) rosną z każdą otwartą
    // kartą — powyżej sufitu wypada najstarszy wpis (Map trzyma kolejność).
    this.entries.delete(key);
    if (this.entries.size >= MAX_CACHE_ENTRIES) {
      const [oldest] = this.entries.keys();
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    if (!entry.settled) {
      void entry.value.then((state) => {
        entry.settled = state;
      });
    }
    this.entries.set(key, entry);
  }

  /** Po zapisie u dostawcy — następny odczyt idzie po świeże dane. */
  invalidate(key: string): void {
    this.entries.delete(key);
  }

  /** Wszystkie klucze z przedrostkiem (np. `railway:` — strony usług we wszystkich okresach). */
  invalidatePrefix(prefix: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }
}

async function toState<T>(
  load: () => Promise<T>,
): Promise<IntegrationState<T>> {
  const fetchedAt = new Date().toISOString();
  try {
    return { status: 'ok', data: await load(), fetchedAt };
  } catch (error) {
    if (!(error instanceof IntegrationError)) {
      logger.error(
        `integracja: ${error instanceof Error ? error.stack : String(error)}`,
      );
    }
    return {
      status: 'error',
      message:
        error instanceof IntegrationError
          ? error.message
          : 'Nieoczekiwany błąd integracji — szczegóły w logu backendu.',
      fetchedAt,
    };
  }
}
