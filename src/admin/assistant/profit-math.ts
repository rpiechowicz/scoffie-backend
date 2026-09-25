import { netRevenuePln } from '../../config/ai-unit-economics';
import { SUBSCRIPTION_PRODUCTS } from '../../config/subscription-products';
import type { ProfitPeriod, ProposalStatus } from '../contract';
import {
  addDays,
  warsawDateKey,
  warsawDayStart,
} from '../common/warsaw-calendar';

/**
 * Czysta arytmetyka ekranu „Rentowność asystenta” — bez Prismy, żeby każdą
 * regułę dało się sprawdzić testem jednostkowym (`profit-math.spec.ts`).
 * Zapytania do bazy są w `admin-profit.service.ts`.
 */

// ——— okres ———

/** Jeden dzień kalendarzowy w Polsce: `[start, end)` jako chwile UTC. */
export type DayWindow = { key: string; start: Date; end: Date };

export type ProfitWindow = { days: DayWindow[]; from: Date; to: Date };

export const PROFIT_PERIODS: readonly ProfitPeriod[] = ['7', '30', 'month'];

export function isProfitPeriod(value: unknown): value is ProfitPeriod {
  return PROFIT_PERIODS.includes(value as ProfitPeriod);
}

function windowOf(firstKey: string, length: number): ProfitWindow {
  const days = Array.from({ length }, (_, index) => {
    const key = addDays(firstKey, index);
    return {
      key,
      start: warsawDayStart(key),
      end: warsawDayStart(addDays(key, 1)),
    };
  });
  return { days, from: days[0].start, to: days[days.length - 1].end };
}

/**
 * Okres ekranu i okres poprzedni TEJ SAMEJ długości, tuż przed nim.
 *
 * `7` i `30` to ostatnie N dni łącznie z dzisiejszym; `month` — od pierwszego
 * dnia bieżącego miesiąca do dziś (czyli tyle dni, ile ma dzisiejsza data),
 * a poprzedni okres to tyle samo dni bezpośrednio przed pierwszym — nie
 * „ten sam kawałek poprzedniego miesiąca”, bo trend ma porównywać okna
 * równej długości niezależnie od wybranego okresu.
 */
export function profitWindows(
  period: ProfitPeriod,
  now: Date,
): { current: ProfitWindow; previous: ProfitWindow } {
  const today = warsawDateKey(now);
  const length =
    period === '7' ? 7 : period === '30' ? 30 : Number(today.slice(8, 10));
  const first = addDays(today, -(length - 1));
  return {
    current: windowOf(first, length),
    previous: windowOf(addDays(first, -length), length),
  };
}

// ——— przychód ———

/**
 * Ile dni ma „miesiąc” przy rozkładaniu miesięcznej ceny na dni.
 *
 * UPROSZCZENIE (brief panelu): dzienny przychód = miesięczny przychód netto
 * ÷ 30, niezależnie od długości miesiąca i od dnia, w którym Apple naprawdę
 * pobrało pieniądze. Suma 30 dni daje dokładnie miesięczne netto jednej
 * subskrypcji; luty i miesiące 31-dniowe rozjeżdżają się o 1–2 dni ceny.
 */
export const DAYS_PER_MONTH = 30;

/** Pola `Subscription`, z których składa się przychód. */
export type RevenueSubscription = {
  provider: string;
  productId: string;
  environment: string | null;
  ownershipType: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  operatorHoldAt: Date | null;
};

/**
 * Dzienny przychód netto (zł) z jednej subskrypcji — albo 0, gdy nie niesie
 * pieniędzy:
 *   - nadanie ręczne (`MANUAL`) jest darmowe,
 *   - `Sandbox` to TestFlight i recenzja App Store — nikt nie płaci,
 *   - `FAMILY_SHARED` to kopia cudzej opłaty z Chmury Rodzinnej: pieniądze
 *     liczą się raz, na wierszu płatnika (`PURCHASED`),
 *   - nieznany SKU nie ma ceny w `SUBSCRIPTION_PRODUCTS`.
 */
export function dailyNetRevenuePln(sub: RevenueSubscription): number {
  if (sub.provider !== 'APPLE') return 0;
  if (sub.environment !== 'Production') return 0;
  if (sub.ownershipType === 'FAMILY_SHARED') return 0;
  const product = SUBSCRIPTION_PRODUCTS[sub.productId];
  if (!product) return 0;
  return netRevenuePln(product.pricePln) / DAYS_PER_MONTH;
}

/**
 * Koniec opłaconego okresu odtworzony z BIEŻĄCEGO stanu wiersza: najwcześniejsze
 * z `expiresAt` (koniec ostatniego opłaconego okresu — przy odnawianej
 * subskrypcji leży w przyszłości), `revokedAt` (zwrot pieniędzy) i
 * `operatorHoldAt` (blokada obsługi). Brak `expiresAt` przy APPLE znaczy „nie
 * wiemy” — jak w `subscriptionAlive`, taki wiersz nie niesie przychodu.
 *
 * Łaska płatnicza (GRACE) NIE jest przychodem: Apple dopiero próbuje pobrać
 * pieniądze, a udane odnowienie przesunie `expiresAt` samo.
 *
 * ŚWIADOMIE INACZEJ NIŻ MRR. MRR (pulpit i ekran Subskrypcje,
 * `subscription-metrics.ts` › `revenueSpans`) liczy GRACE, bo mówi, ile
 * przychodu jest „w umowach" teraz — klient w łasce wciąż ma dostęp i zwykle
 * płaci po ponowieniu. Rentowność zestawia koszt modelu z pieniędzmi
 * NAPRAWDĘ pobranymi za dany dzień, więc łaska wchodzi dopiero wtedy, gdy
 * odnowienie się uda (i przesunie `expiresAt`). Wyłączenia wierszy (MANUAL,
 * Sandbox, FAMILY_SHARED, nieznany SKU) są w obu miejscach te same.
 *
 * Historia z bieżącego wiersza jest przybliżeniem: przerwa w subskrypcji,
 * po której ta sama umowa wróciła (ten sam `originalTransactionId`), wygląda
 * tu jak ciągłość. Dokładną historię da dopiero nocne `AdminDailyStat` (§6).
 */
export function paidUntil(sub: RevenueSubscription): Date | null {
  if (!sub.expiresAt) return null;
  const ends = [sub.expiresAt, sub.revokedAt, sub.operatorHoldAt]
    .filter((value): value is Date => value instanceof Date)
    .map((value) => value.getTime());
  return new Date(Math.min(...ends));
}

/**
 * Czy subskrypcja płaciła za dzień `[start, end)`: zaczęła się przed jego
 * końcem, a opłacony okres sięga co najmniej końca dnia. Dzień zakupu się
 * liczy, dzień wygaśnięcia — nie, więc okres 30-dniowy daje równo 30 dni ceny.
 */
export function paysForDay(sub: RevenueSubscription, day: DayWindow): boolean {
  const until = paidUntil(sub);
  if (!until) return false;
  return (
    sub.createdAt.getTime() < day.end.getTime() &&
    until.getTime() >= day.end.getTime()
  );
}

/** Przychód netto (zł) subskrypcji w każdym z dni — niezaokrąglony. */
export function revenueByDay(
  sub: RevenueSubscription,
  days: readonly DayWindow[],
): number[] {
  const daily = dailyNetRevenuePln(sub);
  return days.map((day) => (daily > 0 && paysForDay(sub, day) ? daily : 0));
}

// ——— trendy i marża ———

export function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Zmiana w procentach wobec poprzedniego okresu. Poprzedni okres bez przychodu
 * nie ma bazy do porównania — wtedy 0 (neutralnie), a nie „nieskończenie
 * dużo” ani sztuczne 100 %.
 */
export function trendPct(current: number, previous: number): number {
  if (!(previous > 0)) return 0;
  return roundTo(((current - previous) / previous) * 100, 1);
}

/**
 * Marża w procentach: ile przychodu netto zostaje po koszcie modelu
 * przeliczonym na złote. Ten sam wzór co na ekranie panelu
 * (`AssistantScreen`), łącznie z 0 przy zerowym przychodzie.
 */
export function marginPct(
  revenueZl: number,
  costUsd: number,
  usdPln: number,
): number {
  if (!(revenueZl > 0)) return 0;
  return ((revenueZl - costUsd * usdPln) / revenueZl) * 100;
}

/**
 * Zmiana marży w punktach procentowych (bieżący − poprzedni okres).
 *
 * Poprzedni okres bez przychodu nie ma marży (dzielenie przez zero), więc
 * nie ma też porównania — wtedy 0, jak w `trendPct`. Liczone wobec umownego
 * 0 % pokazywałoby CAŁĄ bieżącą marżę jako „wzrost”; front przy zmianie 0
 * i bieżącym przychodzie > 0 chowa plakietkę trendu. Bieżący okres bez
 * przychodu zostaje spadkiem do 0 % — przychód realnie zniknął.
 */
export function marginTrendPp(
  current: { revenueZl: number; costUsd: number },
  previous: { revenueZl: number; costUsd: number },
  usdPln: number,
): number {
  if (!(previous.revenueZl > 0)) return 0; // brak porównania
  return roundTo(
    marginPct(current.revenueZl, current.costUsd, usdPln) -
      marginPct(previous.revenueZl, previous.costUsd, usdPln),
    1,
  );
}

// ——— czas tury ———

/**
 * Lewe krańce kubełków czasu tury w sekundach; kubełek `[a, b)`, ostatni
 * otwarty. Etykiety (`0–4`, …, `30+`, z półpauzą) są kontraktem z panelem —
 * front rozpoznaje w nich p50/p95 po `split('–')`.
 */
const TURN_BUCKET_BOUNDS_S = [0, 4, 6, 8, 10, 15, 20, 30] as const;

export const TURN_BUCKET_LABELS: readonly string[] = TURN_BUCKET_BOUNDS_S.map(
  (bound, index) => {
    const next = TURN_BUCKET_BOUNDS_S[index + 1];
    return next === undefined ? `${bound}+` : `${bound}–${next}`;
  },
);

/**
 * Progi dla `width_bucket(durationMs, progi)` w Postgresie: lewe krańce
 * kubełków od drugiego, w ms. `width_bucket` oddaje 0 poniżej pierwszego
 * progu i `i` dla `[progi[i-1], progi[i])` — czyli dokładnie indeks etykiety.
 */
export const TURN_BUCKET_THRESHOLDS_MS: readonly number[] =
  TURN_BUCKET_BOUNDS_S.slice(1).map((seconds) => seconds * 1000);

/** Indeks kubełka dla czasu tury — to samo, co liczy `width_bucket` w bazie. */
export function turnBucketIndex(durationMs: number): number {
  let index = 0;
  for (const threshold of TURN_BUCKET_THRESHOLDS_MS) {
    if (durationMs >= threshold) index += 1;
  }
  return index;
}

/** Histogram z liczników `indeks kubełka → liczba tur`; brakujące kubełki = 0. */
export function turnHistogram(
  counts: ReadonlyMap<number, number>,
): { bucket: string; count: number }[] {
  return TURN_BUCKET_LABELS.map((bucket, index) => ({
    bucket,
    count: counts.get(index) ?? 0,
  }));
}

/** Milisekundy → sekundy z jednym miejscem po przecinku (0, gdy brak danych). */
export function secondsOf(durationMs: number | null | undefined): number {
  if (durationMs === null || durationMs === undefined) return 0;
  return roundTo(durationMs / 1000, 1);
}

// ——— propozycje ———

export const PROPOSAL_STATUSES: readonly ProposalStatus[] = [
  'PENDING',
  'APPLIED',
  'UNDONE',
  'STALE',
  'EXPIRED',
  'FAILED',
];

/** Wszystkie statusy z kontraktu, zera dla brakujących; nieznane odpadają. */
export function proposalCounts(
  rows: readonly { status: string; count: number }[],
): Record<ProposalStatus, number> {
  const result = Object.fromEntries(
    PROPOSAL_STATUSES.map((status) => [status, 0]),
  ) as Record<ProposalStatus, number>;
  for (const row of rows) {
    if ((PROPOSAL_STATUSES as readonly string[]).includes(row.status)) {
      result[row.status as ProposalStatus] += row.count;
    }
  }
  return result;
}

/** Mikrodolary → dolary. */
export const usdOf = (microUsd: number): number => microUsd / 1_000_000;
