import {
  DEFAULT_GRACE_DAYS,
  SUBSCRIPTION_CLOCK_SKEW_MS,
} from '../../config/subscription-lifetime';
import type { Trend } from '../contract';
import {
  mrrAt,
  revenueSpans,
  type MetricSubscription,
} from '../subscriptions/subscription-metrics';
import type { PanelDay } from '../common/warsaw-calendar';

/**
 * Arytmetyka pulpitu bez bazy: trendy procentowe i stan subskrypcji w
 * przeszłości. Osobno od serwisu, bo pomyłka tutaj nie wywraca żadnego
 * żądania — po prostu pokazuje złą liczbę — więc pilnują jej testy
 * jednostkowe, nie e2e.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Zmiana procentowa `current` względem `previous`, zaokrąglona do 0,1 pkt.
 * `null`, gdy nie ma bazy: z zera do czegokolwiek to nie jest „+∞ %", tylko
 * brak porównania.
 */
export function percentChange(
  current: number,
  previous: number,
): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/**
 * Trend serii dziennej, której ostatni punkt to „teraz": `d1` wobec
 * poprzedniego punktu, `d7` wobec punktu sprzed tygodnia. Kontrakt wymaga
 * liczby w `d1`, więc brak bazy daje tam 0; `d7` jest opcjonalne i wtedy
 * znika — panel chowa wówczas dopisek „w 7 dni".
 */
export function trendOfSeries(series: readonly number[]): Trend {
  const last = series.length - 1;
  const d1 = last >= 1 ? percentChange(series[last], series[last - 1]) : null;
  const d7 = last >= 7 ? percentChange(series[last], series[last - 7]) : null;
  return d7 === null ? { d1: d1 ?? 0 } : { d1: d1 ?? 0, d7 };
}

/**
 * Chwile, na które liczymy stan serii dziennej: koniec każdej minionej doby
 * (ostatnia milisekunda) i „teraz" dla dzisiejszej. Dziś NIE jest „na koniec
 * dnia" — koniec dzisiejszej doby jest w przyszłości i wyrzucałby
 * subskrypcje, które wygasają wieczorem, choć teraz jeszcze żyją.
 */
export function endOfDayPoints(days: readonly PanelDay[], now: Date): Date[] {
  return days.map((day, index) =>
    index === days.length - 1 ? now : new Date(day.end.getTime() - 1),
  );
}

/** Tyle pól `Subscription`, ile trzeba do odtworzenia stanu w przeszłości. */
export type SubscriptionHistoryRow = {
  productId: string;
  status: string;
  environment: string | null;
  expiresAt: Date | null;
  graceExpiresAt: Date | null;
  neverExpires: boolean;
  revokedAt: Date | null;
  operatorHoldAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Środowisko, które jest przychodem. Sandbox (TestFlight, recenzja) — nie. */
export const MRR_ENVIRONMENT = 'Production';

const isLiveStatus = (status: string) =>
  status === 'ACTIVE' || status === 'GRACE';

/**
 * Czy subskrypcja była opłacona (ACTIVE albo GRACE) w chwili `at`.
 *
 * Tabela trzyma tylko stan BIEŻĄCY, więc przeszłość odtwarzamy z dat:
 * `createdAt` (od kiedy ją znamy), `revokedAt` i `operatorHoldAt` (od kiedy
 * nie daje dostępu) i koniec opłaconego okresu. Dla żywego wiersza w chwili
 * „teraz" to dokładnie `subscriptionAlive` (test parytetu obok) — z jedną
 * różnicą z definicji: liczy się tylko Production.
 *
 * Wiersz martwy (EXPIRED / REVOKED) zmienił status najpóźniej przy ostatnim
 * zapisie, więc po `updatedAt` na pewno już nie żył — to domyka przypadek
 * wiersza, któremu Apple wpisało datę końca w przyszłości, a status już
 * zdjęło. Czego się NIE da odtworzyć: przerwy w środku historii (wygasła
 * i wróciła z tym samym `originalTransactionId`) — wiersz wygląda wtedy tak,
 * jakby żył bez przerwy.
 */
export function paidAt(row: SubscriptionHistoryRow, at: Date): boolean {
  if (row.environment !== MRR_ENVIRONMENT) return false;
  const t = at.getTime();
  if (row.createdAt.getTime() > t) return false;
  if (row.revokedAt && row.revokedAt.getTime() <= t) return false;
  if (row.operatorHoldAt && row.operatorHoldAt.getTime() <= t) return false;

  const live = isLiveStatus(row.status);
  if (!live && row.updatedAt.getTime() <= t) return false;
  if (live && row.neverExpires) return true;

  const until = paidUntil(row);
  if (!until) return false;
  return until.getTime() + SUBSCRIPTION_CLOCK_SKEW_MS > t;
}

/**
 * Koniec opłaconego okresu. Dla żywych — ta sama reguła, co w
 * `subscriptionAlive` (GRACE ma własną datę albo 16 dni łaski). Dla martwych
 * łaska zgłoszona przez Apple przedłuża okres: wtedy wiersz był w GRACE,
 * a GRACE liczy się do przychodu.
 */
function paidUntil(row: SubscriptionHistoryRow): Date | null {
  if (row.status === 'GRACE') {
    return (
      row.graceExpiresAt ??
      (row.expiresAt
        ? new Date(row.expiresAt.getTime() + DEFAULT_GRACE_DAYS * DAY_MS)
        : null)
    );
  }
  if (row.status === 'ACTIVE') return row.expiresAt;
  if (row.expiresAt && row.graceExpiresAt) {
    return row.graceExpiresAt > row.expiresAt
      ? row.graceExpiresAt
      : row.expiresAt;
  }
  return row.expiresAt ?? row.graceExpiresAt;
}

/**
 * Liczba opłaconych subskrypcji (Production, ACTIVE/GRACE) w każdej chwili
 * z `points`. W chwili „teraz" to ta sama liczba, co „aktywne" na ekranie
 * Subskrypcje (żywe wiersze App Store z produkcji, z Chmurą Rodzinną).
 */
export function paidCounts(
  rows: readonly SubscriptionHistoryRow[],
  points: readonly Date[],
): number[] {
  return points.map((point) => rows.filter((row) => paidAt(row, point)).length);
}

/**
 * MRR w każdej chwili z `points` — JEDNA definicja z ekranem Subskrypcje
 * (`revenueSpans` + `mrrAt`): bez `FAMILY_SHARED` (kopia cudzej opłaty),
 * bez nadań ręcznych i Sandboxa, nieznany SKU za 0 zł. Wcześniej pulpit
 * sumował ceny wszystkich opłaconych wierszy i pokazywał inne MRR niż
 * ekran obok.
 */
export function mrrSeries(
  rows: readonly MetricSubscription[],
  points: readonly Date[],
  now: Date,
): number[] {
  const spans = revenueSpans(rows, now);
  return points.map((point) => mrrAt(spans, point));
}

/** Makro przepisu jest na CAŁY przepis — na porcję dzielimy przez `servings`. */
export function kcalPerServing(
  nutritionKcal: number,
  servings: number,
): number {
  return Math.round(nutritionKcal / Math.max(1, servings));
}
