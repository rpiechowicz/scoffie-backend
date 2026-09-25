/**
 * Przejścia z wierszy widoków systemowych Postgresa na kontrakt panelu —
 * bez Prismy (`database-stats.spec.ts`). Liczby z `pg_*` przychodzą jako
 * `bigint`/`numeric`/tekst zależnie od sterownika, stąd `toNumber`.
 */
import type { DatabaseSlowQuery } from '../contract';

/** Zapytanie trwające dłużej niż tyle sekund trafia do „długich”. */
export const LONG_QUERY_SECONDS = 5;
/** Tekst z `pg_stat_statements` przycinamy do tylu znaków. */
export const SLOW_QUERY_TEXT_MAX = 200;

export function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  // `Prisma.Decimal` (np. `numeric` z `EXTRACT`) — ma własne `toString`.
  if (value && typeof value === 'object') {
    const parsed = Number((value as { toString(): string }).toString());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** Tekst znormalizowany (`$1`) — białe znaki zwinięte, przycięty. */
export function trimQueryText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SLOW_QUERY_TEXT_MAX
    ? `${flat.slice(0, SLOW_QUERY_TEXT_MAX - 1)}…`
    : flat;
}

export function toSlowQuery(row: {
  query: unknown;
  calls: unknown;
  meanMs: unknown;
  totalMs: unknown;
}): DatabaseSlowQuery {
  return {
    query: trimQueryText(typeof row.query === 'string' ? row.query : ''),
    calls: Math.round(toNumber(row.calls)),
    meanMs: Math.round(toNumber(row.meanMs) * 10) / 10,
    totalMs: Math.round(toNumber(row.totalMs)),
  };
}

/** `reltuples` = -1 przed pierwszym ANALYZE (PG14+) — pokazujemy 0. */
export function rowsEstimate(value: unknown): number {
  return Math.max(0, Math.round(toNumber(value)));
}
