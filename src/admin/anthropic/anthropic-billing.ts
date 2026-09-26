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

/** Wydatki od chwili kotwicy: pełne doby po dobie kotwicy + część doby kotwicy. */
export function spentSince(
  days: Map<string, DayCost>,
  at: Date,
  anchorDayUsage: Bucket<UsageResult>[],
): number {
  const anchorKey = dayKey(at);
  let spent = 0;
  for (const [key, day] of days) if (key > anchorKey) spent += day.usd;
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
};

export function buildBilling(input: {
  configured: boolean;
  error: string | null;
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
  for (const bucket of raw?.usageDaily ?? []) {
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
          const spent = round2(spentSince(days, anchor.at, raw.anchorDay));
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
