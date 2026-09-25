import { REFERENCE_USD_PLN } from '../../config/ai-unit-economics';
import { addDays } from '../common/warsaw-calendar';

/**
 * Kursy średnie NBP (tabela A) — czyste funkcje: odpowiedź API → wiersze
 * `FxRate`, okno pobrania, „kurs na dzień” z fallbackiem. Pobiera
 * i zapisuje `FxRateService`.
 *
 * Tabela A ma ~33 waluty (USD, EUR, GBP, CHF, SEK, JPY, …) i wychodzi
 * w dni robocze. Weekend i święto nie mają notowania — obowiązuje ostatni
 * wcześniejszy kurs (tak liczy też NBP „kurs z dnia poprzedzającego”).
 */

export const NBP_API = 'https://api.nbp.pl/api/exchangerates';

/**
 * Przy pierwszym uruchomieniu (pusta tabela) — tyle dni wstecz: rok ekranu
 * „Wypłaty z Apple” (okres 365 dni i 12 miesięcy rozliczeń) z zapasem.
 */
export const FX_BACKFILL_DAYS = 370;
/** NBP odrzuca zapytanie o zakres dłuższy niż 93 dni. */
export const NBP_MAX_RANGE_DAYS = 93;

export type FxPair = `${string}/PLN`;
export const USD_PLN: FxPair = 'USD/PLN';
export const EUR_PLN: FxPair = 'EUR/PLN';

export type FxRateRow = {
  /** dzień notowania `YYYY-MM-DD` */
  date: string;
  pair: FxPair;
  rate: number;
  /** numer tabeli, np. `186/A/NBP/2026` */
  source: string;
};

type NbpTable = {
  table?: unknown;
  no?: unknown;
  effectiveDate?: unknown;
  rates?: { code?: unknown; mid?: unknown }[];
};

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `GET /tables/a/{od}/{do}/?format=json` → wiersze. Defensywnie: pozycja
 * bez kodu, z kursem ≤ 0 albo z nieczytelną datą wypada, reszta zostaje.
 */
export function parseNbpTables(body: unknown): FxRateRow[] {
  if (!Array.isArray(body)) return [];
  const rows: FxRateRow[] = [];
  for (const table of body as NbpTable[]) {
    const date =
      typeof table?.effectiveDate === 'string' ? table.effectiveDate : '';
    if (!DAY_KEY.test(date)) continue;
    const source =
      typeof table.no === 'string' && table.no ? table.no : `NBP ${date}`;
    for (const rate of Array.isArray(table.rates) ? table.rates : []) {
      const code = typeof rate?.code === 'string' ? rate.code.trim() : '';
      const mid = typeof rate?.mid === 'number' ? rate.mid : Number.NaN;
      if (!/^[A-Z]{3}$/.test(code) || !(mid > 0)) continue;
      rows.push({ date, pair: `${code}/PLN`, rate: mid, source });
    }
  }
  return rows;
}

export function nbpTablesUrl(from: string, to: string): string {
  return `${NBP_API}/tables/a/${from}/${to}/?format=json`;
}

/**
 * Jakie zakresy pobrać: pusta tabela — rok wstecz; inaczej od dnia po
 * ostatnim notowaniu do dziś (dziura dłuższa niż rok — tylko ostatni rok).
 * Każdy zakres ≤ 93 dni (limit NBP), od najstarszego. Pusta lista — nic do
 * pobrania.
 */
export function fxFetchWindows(
  latest: string | null,
  today: string,
): { from: string; to: string }[] {
  const earliest = addDays(today, -FX_BACKFILL_DAYS);
  const from = latest ? addDays(latest, 1) : earliest;
  const windows: { from: string; to: string }[] = [];
  for (
    let start = from < earliest ? earliest : from;
    start <= today;
    start = addDays(start, NBP_MAX_RANGE_DAYS)
  ) {
    const end = addDays(start, NBP_MAX_RANGE_DAYS - 1);
    windows.push({ from: start, to: end < today ? end : today });
  }
  return windows;
}

export type RateOnDay = {
  rate: number;
  /** dzień notowania; `null` — stała cennika */
  date: string | null;
  source: 'NBP' | 'REFERENCE';
};

/**
 * Księga kursów w pamięci: „kurs na dzień” = ostatnie notowanie NIE później
 * niż ten dzień. Wiersze w dowolnej kolejności.
 */
export class FxBook {
  private readonly byPair = new Map<string, { date: string; rate: number }[]>();

  constructor(rows: readonly { date: string; pair: string; rate: number }[]) {
    for (const row of rows) {
      const list = this.byPair.get(row.pair) ?? [];
      list.push({ date: row.date, rate: row.rate });
      this.byPair.set(row.pair, list);
    }
    for (const list of this.byPair.values()) {
      list.sort((a, b) => a.date.localeCompare(b.date));
    }
  }

  /** Kurs waluty w PLN na dzień; PLN = 1; brak notowania — `null`. */
  toPln(currency: string, date: string): number | null {
    if (currency === 'PLN') return 1;
    return this.on(`${currency}/PLN`, date)?.rate ?? null;
  }

  on(pair: string, date: string): { date: string; rate: number } | null {
    const list = this.byPair.get(pair);
    if (!list) return null;
    // Binarnie: ostatni indeks z `date <= dzień`.
    let lo = 0;
    let hi = list.length - 1;
    let hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].date <= date) {
        hit = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return hit >= 0 ? list[hit] : null;
  }

  /** USD/PLN z fallbackiem do kursu cennika (`REFERENCE_USD_PLN`). */
  usdPln(date: string): RateOnDay {
    return withReference(this.on(USD_PLN, date));
  }
}

export function withReference(
  hit: { date: string; rate: number } | null,
): RateOnDay {
  return hit
    ? { rate: hit.rate, date: hit.date, source: 'NBP' }
    : { rate: REFERENCE_USD_PLN, date: null, source: 'REFERENCE' };
}

/** `@db.Date` ↔ klucz dnia (kolumna DATE przychodzi jako północ UTC). */
export const dateOfKey = (key: string): Date =>
  new Date(`${key}T00:00:00.000Z`);
export const keyOfDate = (date: Date): string =>
  date.toISOString().slice(0, 10);
