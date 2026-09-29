import type { AnthropicBilling } from '../contract';
import type {
  Bucket,
  CostResult,
  UsageResult,
} from './anthropic-billing.client';

/**
 * Arytmetyka kredytów Claude — CZYSTE funkcje: raporty Anthropic + kotwice
 * z bazy → `AnthropicBilling`. Bez sieci i bez zegara (dostają `now`).
 *
 * Doby to doby UTC: tak kubełkuje Cost API (tylko `1d`) i tak liczy się
 * „ten miesiąc” w Console. Doby warszawskiej z kubełków UTC nie da się
 * odtworzyć — koszt nie ma godzin.
 */

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
/** Dalej wstecz nie pytamy — kotwica starsza niż pół roku liczy się od tej granicy. */
export const MAX_LOOKBACK_DAYS = 186;
export const DAILY_DAYS = 31;
export const ANCHORS_SHOWN = 20;

export const round2 = (x: number): number => Math.round(x * 100) / 100;

/** `"123.45"` (centy) → 1.2345 USD; śmieci → 0. */
export function centsToUsd(amount: string | null | undefined): number {
  const cents = Number(amount);
  return Number.isFinite(cents) ? cents / 100 : 0;
}

export const utcDay = (d: Date): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
export const dayKey = (d: Date): string => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number): Date =>
  new Date(d.getTime() + n * DAY_MS);
const monthStart = (d: Date, offset = 0): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1));

/** Zakresy zapytań do Anthropic dla chwili `now` i (opcjonalnej) kotwicy. */
export function billingRange(now: Date, anchorAt: Date | null) {
  const today = utcDay(now);
  const tomorrow = addDays(today, 1);
  const floor = addDays(today, -MAX_LOOKBACK_DAYS);
  const candidates = [monthStart(now, -1), addDays(today, -(DAILY_DAYS - 1))];
  if (anchorAt) candidates.push(utcDay(anchorAt));
  const costFrom = new Date(
    Math.max(floor.getTime(), Math.min(...candidates.map((d) => d.getTime()))),
  );
  const hourNow = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
  const anchorDay = anchorAt && anchorAt >= floor ? utcDay(anchorAt) : null;
  return {
    today,
    /** koniec wyłączny: jutro 00:00 UTC, żeby doba w toku też przyszła */
    to: tomorrow,
    costFrom,
    usageFrom: new Date(
      Math.min(monthStart(now).getTime(), addDays(today, -6).getTime()),
    ),
    hourlyFrom: new Date(hourNow.getTime() - 23 * HOUR_MS),
    hourlyTo: new Date(hourNow.getTime() + HOUR_MS),
    /** od wczoraj: tuż po północy UTC Cost API może jeszcze nie mieć minionej doby */
    recentFrom: addDays(today, -1),
    anchorDay,
  };
}

/** Zakres zapytania o własną księgę kosztu: 31 dób albo od początku miesiąca UTC — co wcześniej. */
export function ledgerRange(now: Date): { from: Date; to: Date } {
  const today = utcDay(now);
  return {
    from: new Date(
      Math.min(
        monthStart(now).getTime(),
        addDays(today, -(DAILY_DAYS - 1)).getTime(),
      ),
    ),
    to: addDays(today, 1),
  };
}

/** Wiersz księgi: doba UTC `YYYY-MM-DD` i suma `AiUsage.costMicroUsd`. */
export type LedgerRow = { day: string; microUsd: number };

/**
 * Koszt asystenta z własnej księgi (`AiUsage`) w tych samych dobach UTC co
 * wydatki z Anthropic — `last7Usd` to dziś i 6 poprzednich dób, miesiąc UTC.
 */
export function buildLedger(
  rows: LedgerRow[],
  now: Date,
): NonNullable<AnthropicBilling['ledger']> {
  const today = utcDay(now);
  const byDay = new Map<string, number>();
  for (const r of rows) {
    byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.microUsd / 1_000_000);
  }
  const usdOn = (d: Date) => byDay.get(dayKey(d)) ?? 0;
  let last7 = 0;
  for (let i = 0; i <= 6; i++) last7 += usdOn(addDays(today, -i));
  const monthKey = dayKey(today).slice(0, 7);
  const month = [...byDay].reduce(
    (s, [k, usd]) => (k.startsWith(monthKey) ? s + usd : s),
    0,
  );
  return {
    todayUsd: round2(usdOn(today)),
    last7Usd: round2(last7),
    monthUsd: round2(month),
    daily: Array.from({ length: DAILY_DAYS }, (_, i) => {
      const date = addDays(today, i - (DAILY_DAYS - 1));
      return { date: dayKey(date), usd: round2(usdOn(date)) };
    }),
  };
}

/** Koszt bez modelu (wyszukiwanie, kod) — pod swoim rodzajem. */
export const costKey = (r: CostResult): string =>
  r.model ?? r.cost_type ?? r.description ?? 'inne';

type DayCost = { usd: number; byModel: Map<string, number> };

export function costByDay(buckets: Bucket<CostResult>[]): Map<string, DayCost> {
  const days = new Map<string, DayCost>();
  for (const bucket of buckets) {
    const key = bucket.starting_at.slice(0, 10);
    const day = days.get(key) ?? { usd: 0, byModel: new Map() };
    for (const r of bucket.results ?? []) {
      const usd = centsToUsd(r.amount);
      day.usd += usd;
      day.byModel.set(costKey(r), (day.byModel.get(costKey(r)) ?? 0) + usd);
    }
    days.set(key, day);
  }
  return days;
}

const cacheWrite = (r: UsageResult): number =>
  (r.cache_creation?.ephemeral_5m_input_tokens ?? 0) +
  (r.cache_creation?.ephemeral_1h_input_tokens ?? 0);

/**
 * Tokeny ważone względną ceną (wyjście 5×, odczyt cache 0,1×, zapis cache
 * 1,25× / 2×) — te proporcje są wspólne dla obecnych modeli, więc udział
 * kosztu doby liczymy bez tabeli cen.
 */
export const costWeight = (r: UsageResult): number =>
  (r.uncached_input_tokens ?? 0) +
  (r.output_tokens ?? 0) * 5 +
  (r.cache_read_input_tokens ?? 0) * 0.1 +
  (r.cache_creation?.ephemeral_5m_input_tokens ?? 0) * 1.25 +
  (r.cache_creation?.ephemeral_1h_input_tokens ?? 0) * 2;

/**
 * Jaka część kosztu doby kotwicy przypada na czas po `at`: ważone tokeny
 * godzin po `at` (godzina przecięta — proporcjonalnie) przez ważone tokeny
 * całej doby. Doba bez tokenów — udział czasu, jaki został do jej końca.
 */
export function shareAfter(buckets: Bucket<UsageResult>[], at: Date): number {
  let total = 0;
  let after = 0;
  for (const bucket of buckets) {
    const start = Date.parse(bucket.starting_at);
    const end = Date.parse(bucket.ending_at);
    if (!(end > start)) continue;
    const weight = (bucket.results ?? []).reduce(
      (s, r) => s + costWeight(r),
      0,
    );
    const fraction = Math.min(
      1,
      Math.max(0, (end - Math.max(at.getTime(), start)) / (end - start)),
    );
    total += weight;
    after += weight * fraction;
  }
  if (total > 0) return after / total;
  const dayEnd = utcDay(at).getTime() + DAY_MS;
  return Math.min(1, Math.max(0, (dayEnd - at.getTime()) / DAY_MS));
}

/**
 * Cennik Anthropic w $/MTok — TYLKO do szacunku doby, której Cost API
 * jeszcze nie rozliczył. Zapis do cache: 1,25× (5 min) i 2× (1 h) ceny
 * wejścia; odczyt z cache ma własną cenę (Fable 5.1 i Opus 5.5 nie trzymają
 * się 0,1×). Prefiksy od najdłuższego; identyfikatory z datą
 * (`claude-haiku-4-5-20251001`) łapie prefiks. Stan z 26.09.2026, zgodny
 * z rachunkiem (Sonnet 5 z Cost API co do centa).
 */
type Price = { input: number; output: number; cacheRead: number };
const price = (input: number, output: number, cacheRead = input / 10) => ({
  input,
  output,
  cacheRead,
});
const PRICES: [prefix: string, price: Price][] = [
  ['claude-fable-5-1', price(10, 50, 0.25)],
  ['claude-mythos-5-1', price(10, 50, 0.25)],
  ['claude-fable-5', price(10, 50)],
  ['claude-mythos', price(10, 50)],
  ['claude-opus-5-5', price(4, 20, 0.2)],
  ['claude-opus-5', price(5, 25)],
  ['claude-opus-4-8', price(5, 25)],
  ['claude-opus-4-7', price(5, 25)],
  ['claude-opus-4-6', price(5, 25)],
  ['claude-opus-4-5', price(5, 25)],
  ['claude-opus-4', price(15, 75)],
  ['claude-sonnet-5-5', price(2, 10)],
  ['claude-sonnet-5', price(2, 10)],
  ['claude-sonnet-4', price(3, 15)],
  ['claude-3-7-sonnet', price(3, 15)],
  ['claude-haiku-4-5', price(1, 5)],
  ['claude-3-5-haiku', price(0.8, 4)],
  ['claude-3-haiku', price(0.25, 1.25)],
];
/** Model spoza cennika liczymy po najdroższej stawce — szacunek salda ma raczej zaniżać, niż zawyżać. */
const UNKNOWN_PRICE = price(10, 50);
/** Wyszukiwanie w sieci: $10 za 1000 zapytań. */
const WEB_SEARCH_USD = 0.01;

export function priceFor(model: string | null | undefined): Price {
  const id = model ?? '';
  return PRICES.find(([prefix]) => id.startsWith(prefix))?.[1] ?? UNKNOWN_PRICE;
}

/** Koszt wiersza Usage API wg cennika, USD. */
export function usageUsd(r: UsageResult): number {
  const p = priceFor(r.model);
  const mtok =
    (r.uncached_input_tokens ?? 0) * p.input +
    (r.output_tokens ?? 0) * p.output +
    (r.cache_read_input_tokens ?? 0) * p.cacheRead +
    (r.cache_creation?.ephemeral_5m_input_tokens ?? 0) * p.input * 1.25 +
    (r.cache_creation?.ephemeral_1h_input_tokens ?? 0) * p.input * 2;
  return (
    mtok / 1_000_000 +
    (r.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD
  );
}

/**
 * Cost API oddaje dobę dopiero po jej zamknięciu (26.09.2026: o 20 UTC
 * brak kubełka z tego dnia, choć Usage API miał już tokeny) — bez tego
 * saldo stało w miejscu do następnego dnia. Doby z `recent` (tokeny
 * godzinowe po modelu), których w kosztach nie ma, dopisujemy jako szacunek
 * z cennika. Zwraca klucze dób oszacowanych; `days` uzupełnia w miejscu.
 */
export function estimateMissingDays(
  days: Map<string, DayCost>,
  recent: Bucket<UsageResult>[],
): Set<string> {
  const estimated = new Set<string>();
  for (const bucket of recent) {
    const key = bucket.starting_at.slice(0, 10);
    if (days.has(key) && !estimated.has(key)) continue;
    const day = days.get(key) ?? { usd: 0, byModel: new Map() };
    for (const r of bucket.results ?? []) {
      const usd = usageUsd(r);
      const model = r.model ?? 'inne';
      day.usd += usd;
      day.byModel.set(model, (day.byModel.get(model) ?? 0) + usd);
    }
    days.set(key, day);
    estimated.add(key);
  }
  return estimated;
}

/** Koszt z cennika w godzinach po `at` (godzina przecięta — proporcjonalnie). */
export function usdAfter(buckets: Bucket<UsageResult>[], at: Date): number {
  let usd = 0;
  for (const bucket of buckets) {
    const start = Date.parse(bucket.starting_at);
    const end = Date.parse(bucket.ending_at);
    if (!(end > start)) continue;
    const fraction = Math.min(
      1,
      Math.max(0, (end - Math.max(at.getTime(), start)) / (end - start)),
    );
    if (fraction === 0) continue;
    for (const r of bucket.results ?? []) usd += usageUsd(r) * fraction;
  }
  return usd;
}

/**
 * Wydatki od chwili kotwicy: pełne doby po dobie kotwicy + część doby
 * kotwicy. Doba kotwicy oszacowana z tokenów (`recent`) liczy się godzinami
 * z cennika, rozliczona — udziałem ważonych tokenów w jej koszcie.
 */
export function spentSince(
  days: Map<string, DayCost>,
  at: Date,
  anchorDayUsage: Bucket<UsageResult>[],
  estimated: Set<string> = new Set(),
  recent: Bucket<UsageResult>[] = [],
): number {
  const anchorKey = dayKey(at);
  let spent = 0;
  for (const [key, day] of days) if (key > anchorKey) spent += day.usd;
  if (estimated.has(anchorKey)) {
    return (
      spent +
      usdAfter(
        recent.filter((b) => b.starting_at.startsWith(anchorKey)),
        at,
      )
    );
  }
  const anchorDay = days.get(anchorKey);
  if (anchorDay) spent += anchorDay.usd * shareAfter(anchorDayUsage, at);
  return spent;
}

/** Dni do zera przy średniej z 7 pełnych dób; `null` bez salda albo wydatków. */
export function runwayDays(
  estimatedUsd: number | null,
  avgDailyUsd: number,
): number | null {
  if (estimatedUsd === null || !(avgDailyUsd > 0)) return null;
  return Math.round((Math.max(0, estimatedUsd) / avgDailyUsd) * 10) / 10;
}

export type AnchorRow = {
  id: string;
  at: Date;
  balanceUsd: number;
  amountUsd: number | null;
  note: string | null;
  createdBy: string | null;
};

export type BillingRaw = {
  cost: Bucket<CostResult>[];
  /** kubełki `1d` po modelu od `usageFrom` */
  usageDaily: Bucket<UsageResult>[];
  /** kubełki `1h` z ostatnich 24 h */
  hourly: Bucket<UsageResult>[];
  /** kubełki `1h` doby kotwicy */
  anchorDay: Bucket<UsageResult>[];
  /** kubełki `1h` po modelu od wczoraj 00:00 UTC — szacunek dób, których Cost API jeszcze nie oddał */
  recent: Bucket<UsageResult>[];
};

export function buildBilling(input: {
  configured: boolean;
  error: string | null;
  /** dane z ostatniego udanego odczytu, bo bieżący się nie udał */
  stale?: boolean;
  raw: BillingRaw | null;
  /** najnowsze pierwsze */
  anchors: AnchorRow[];
  lowBalanceUsd: number;
  now: Date;
  fetchedAt: Date;
  /** własna księga kosztu — niezależna od klucza Anthropic */
  ledger?: AnthropicBilling['ledger'];
}): AnthropicBilling {
  const { raw, anchors, now } = input;
  const today = utcDay(now);
  const days = costByDay(raw?.cost ?? []);
  const recent = raw?.recent ?? [];
  const estimated = estimateMissingDays(days, recent);
  const usdOn = (d: Date) => days.get(dayKey(d))?.usd ?? 0;
  const sumDays = (from: number, to: number) => {
    let s = 0;
    for (let i = from; i <= to; i++) s += usdOn(addDays(today, -i));
    return s;
  };
  const monthKey = dayKey(today).slice(0, 7);
  const prevMonthKey = dayKey(monthStart(now, -1)).slice(0, 7);
  const sumMonth = (prefix: string) =>
    [...days].reduce((s, [k, d]) => (k.startsWith(prefix) ? s + d.usd : s), 0);

  const daily = Array.from({ length: DAILY_DAYS }, (_, i) => {
    const date = addDays(today, i - (DAILY_DAYS - 1));
    const day = days.get(dayKey(date));
    return {
      date: dayKey(date),
      usd: round2(day?.usd ?? 0),
      estimated: estimated.has(dayKey(date)),
      byModel: Object.fromEntries(
        [...(day?.byModel ?? [])].map(([m, usd]) => [m, round2(usd)]),
      ),
    };
  });

  // Miesiąc po modelu: dolary z Cost API, tokeny z Usage API.
  const models = new Map<string, AnthropicBilling['byModel'][number]>();
  const row = (model: string) => {
    const hit = models.get(model);
    if (hit) return hit;
    const fresh = {
      model,
      usd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    models.set(model, fresh);
    return fresh;
  };
  for (const [key, day] of days) {
    if (!key.startsWith(monthKey)) continue;
    for (const [model, usd] of day.byModel) row(model).usd += usd;
  }
  let last7Tokens = 0;
  let inputAll = 0;
  let cacheReadAll = 0;
  const weekFrom = dayKey(addDays(today, -6));
  // Doby oszacowane nie mają kubełka dobowego — ich tokeny z godzinowych.
  const usageBuckets = [
    ...(raw?.usageDaily ?? []),
    ...recent.filter((b) => estimated.has(b.starting_at.slice(0, 10))),
  ];
  for (const bucket of usageBuckets) {
    const key = bucket.starting_at.slice(0, 10);
    for (const r of bucket.results ?? []) {
      if (key.startsWith(monthKey)) {
        const m = row(r.model ?? 'inne');
        m.inputTokens += r.uncached_input_tokens ?? 0;
        m.outputTokens += r.output_tokens ?? 0;
        m.cacheReadTokens += r.cache_read_input_tokens ?? 0;
        m.cacheWriteTokens += cacheWrite(r);
      }
      if (key >= weekFrom) {
        const input =
          (r.uncached_input_tokens ?? 0) +
          (r.cache_read_input_tokens ?? 0) +
          cacheWrite(r);
        last7Tokens += input + (r.output_tokens ?? 0);
        inputAll += input;
        cacheReadAll += r.cache_read_input_tokens ?? 0;
      }
    }
  }
  const byModel = [...models.values()]
    .map((m) => ({ ...m, usd: round2(m.usd) }))
    .sort(
      (a, b) =>
        b.usd - a.usd ||
        b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
    );

  const hourly = (raw?.hourly ?? []).map((bucket) => {
    const results = bucket.results ?? [];
    return {
      at: new Date(bucket.starting_at).toISOString(),
      // wejście = bez cache + zapis do cache; odczyt osobno
      inputTokens: results.reduce(
        (s, r) => s + (r.uncached_input_tokens ?? 0) + cacheWrite(r),
        0,
      ),
      outputTokens: results.reduce((s, r) => s + (r.output_tokens ?? 0), 0),
      cacheReadTokens: results.reduce(
        (s, r) => s + (r.cache_read_input_tokens ?? 0),
        0,
      ),
    };
  });

  // Saldo tylko z danymi o wydatkach — bez nich „kotwica − 0” udawałoby pewność.
  const anchor = anchors[0];
  const balance =
    anchor && raw && input.configured && !input.error
      ? (() => {
          const spent = round2(
            spentSince(days, anchor.at, raw.anchorDay, estimated, recent),
          );
          return {
            anchorUsd: round2(anchor.balanceUsd),
            anchorAt: anchor.at.toISOString(),
            spentSinceUsd: spent,
            estimatedUsd: round2(anchor.balanceUsd - spent),
          };
        })()
      : null;

  return {
    configured: input.configured,
    error: input.error,
    stale: input.stale ?? false,
    fetchedAt: input.fetchedAt.toISOString(),
    balance,
    lowBalanceUsd: round2(input.lowBalanceUsd),
    runwayDays: runwayDays(balance?.estimatedUsd ?? null, sumDays(1, 7) / 7),
    spend: {
      todayUsd: round2(usdOn(today)),
      yesterdayUsd: round2(usdOn(addDays(today, -1))),
      last7Usd: round2(sumDays(0, 6)),
      monthUsd: round2(sumMonth(monthKey)),
      prevMonthUsd: round2(sumMonth(prevMonthKey)),
    },
    daily,
    estimatedDays: [...estimated].sort(),
    byModel,
    hourly,
    tokens: {
      last7: last7Tokens,
      cacheReadShare:
        inputAll > 0 ? Math.round((cacheReadAll / inputAll) * 1000) / 1000 : 0,
    },
    anchors: anchors.slice(0, ANCHORS_SHOWN).map((a) => ({
      id: a.id,
      at: a.at.toISOString(),
      balanceUsd: round2(a.balanceUsd),
      amountUsd: a.amountUsd === null ? null : round2(a.amountUsd),
      note: a.note,
      by: a.createdBy,
    })),
    ledger: input.ledger ?? null,
  };
}
