import {
  DEFAULT_GRACE_DAYS,
  subscriptionAlive,
} from '../../config/subscription-lifetime';
import { SUBSCRIPTION_PRODUCTS } from '../../config/subscription-products';
import type { ProductId, SubscriptionsData } from '../contract';
import { isAdminProductId } from './admin-products';

/**
 * Arytmetyka ekranu „Subskrypcje" — czyste funkcje, żeby liczby dało się
 * sprawdzić testem, a nie wiarą (`subscription-metrics.spec.ts`).
 *
 * ŻYWOTNOŚĆ Z DOMENY. „Żywa" znaczy tu dokładnie to, co w `subscriptionAlive`
 * (status, `revokedAt`, blokada operatora, koniec okresu i łaski z tym samym
 * marginesem zegara) — z jednym wyjątkiem: środowisko ocenia wiersz, nie
 * konfiguracja serwera. `subscriptionAlive` odrzuca Sandbox na produkcji, bo
 * pyta „czy TEN serwer ma dać PRO"; statystyka pyta „ile jest żywych
 * subskrypcji z Sandboxa", więc środowisko wiersza filtrujemy osobno.
 */

/** Wiersz `Subscription` — tyle kolumn, ile potrzebują statystyki. */
export type MetricSubscription = {
  id: string;
  provider: string;
  productId: string;
  status: string;
  environment: string | null;
  ownershipType: string | null;
  expiresAt: Date | null;
  graceExpiresAt: Date | null;
  neverExpires: boolean;
  revokedAt: Date | null;
  operatorHoldAt: Date | null;
  autoRenewStatus: boolean | null;
  messagesLimitSnapshot: number | null;
  plansLimitSnapshot: number | null;
  purchaserUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function alive(
  row: MetricSubscription,
  now: Date,
  ignoreHold: boolean,
): boolean {
  return subscriptionAlive(
    {
      ...row,
      environment: null,
      operatorHoldAt: ignoreHold ? null : row.operatorHoldAt,
    },
    now,
  );
}

/** Żywa teraz (domena), niezależnie od środowiska serwera. */
export function liveNow(row: MetricSubscription, now: Date): boolean {
  return alive(row, now, false);
}

/** Żywa, gdyby nie blokada operatora — do „ryzyka odejścia". */
export function liveIgnoringHold(row: MetricSubscription, now: Date): boolean {
  return alive(row, now, true);
}

/** Koniec łaski płatniczej — z domyślnymi 16 dniami, jak `subscriptionAlive`. */
export function graceEnd(row: MetricSubscription): Date | null {
  if (row.graceExpiresAt) return row.graceExpiresAt;
  return row.expiresAt
    ? new Date(row.expiresAt.getTime() + DEFAULT_GRACE_DAYS * DAY_MS)
    : null;
}

/**
 * Czy wiersz niesie PRZYCHÓD do MRR:
 *   • APPLE — nadanie ręczne (`MANUAL`: recenzent, rekompensata) nie płaci,
 *   • Production — Sandbox to testerzy i recenzja App Store,
 *   • nie `FAMILY_SHARED` — każdy członek rodziny ma własną transakcję i
 *     własny wiersz na JEDNEJ opłacie organizatora (patrz
 *     `checkTransactionPayload`); liczenie ich dublowałoby przychód,
 *   • znany produkt — cena bierze się z `SUBSCRIPTION_PRODUCTS`, a ceny
 *     nieznanego SKU nie zmyślamy.
 */
export function carriesRevenue(row: MetricSubscription): boolean {
  return (
    row.provider === 'APPLE' &&
    row.environment === 'Production' &&
    row.ownershipType !== 'FAMILY_SHARED' &&
    SUBSCRIPTION_PRODUCTS[row.productId] !== undefined
  );
}

export function priceOf(row: MetricSubscription): number {
  return SUBSCRIPTION_PRODUCTS[row.productId]?.pricePln ?? 0;
}

/**
 * Kiedy subskrypcja przestała płacić; `null` = płaci dalej.
 *
 * Historii okresów w bazie nie ma (wiersz trzyma tylko stan bieżący), więc
 * koniec odtwarzamy z dat, które zostały: zwrot (`revokedAt`), blokada
 * operatora, koniec łaski albo opłaconego okresu; bez żadnej z nich —
 * ostatnia zmiana wiersza. Wynik nigdy nie wypada po `now`, więc „MRR na
 * dziś" liczony tą funkcją to dokładnie suma żywych wierszy.
 */
export function endedAt(row: MetricSubscription, now: Date): Date | null {
  if (liveNow(row, now)) return null;
  let end: Date;
  if (row.revokedAt) {
    end = row.revokedAt;
  } else if (row.operatorHoldAt) {
    end = row.operatorHoldAt;
  } else if (row.status === 'REVOKED') {
    end = row.updatedAt;
  } else if (row.status === 'GRACE') {
    end = graceEnd(row) ?? row.updatedAt;
  } else {
    // ACTIVE po terminie (zgubione powiadomienie) albo EXPIRED — płaciła do
    // końca okresu, a jeśli przeszła przez łaskę, do jej końca.
    const paidUntil = row.expiresAt;
    const grace =
      row.graceExpiresAt &&
      paidUntil &&
      row.graceExpiresAt.getTime() > paidUntil.getTime()
        ? row.graceExpiresAt
        : null;
    end = grace ?? paidUntil ?? row.updatedAt;
  }
  return end.getTime() < now.getTime() ? end : now;
}

/** Wiersz przychodu przygotowany raz: cena, początek i koniec płacenia. */
export type RevenueSpan = { price: number; from: Date; until: Date | null };

export function revenueSpans(
  rows: readonly MetricSubscription[],
  now: Date,
): RevenueSpan[] {
  return rows.filter(carriesRevenue).map((row) => ({
    price: priceOf(row),
    from: row.createdAt,
    until: endedAt(row, now),
  }));
}

/**
 * MRR w chwili `at`: ceny brutto z cennika wierszy, które wtedy płaciły.
 *
 * PRZYBLIŻENIE, świadome (ROADMAPA §2 o `AdminDailyStat`): produkt to produkt
 * BIEŻĄCY (zmiana planu nie zostawia śladu), początek to założenie wiersza
 * u nas (zgłoszenie z telefonu, zwykle ta sama minuta co zakup), a przerwa
 * między wygaśnięciem a powrotem na tej samej umowie znika. Dokładną
 * historię da dopiero nocna migawka.
 */
export function mrrAt(spans: readonly RevenueSpan[], at: Date): number {
  let total = 0;
  for (const span of spans) {
    if (span.from.getTime() > at.getTime()) continue;
    if (span.until && span.until.getTime() <= at.getTime()) continue;
    total += span.price;
  }
  return roundMoney(total);
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Zmiana procentowa z jednym miejscem po przecinku. Bez podstawy
 * (poprzednio 0) zwraca 0 — wzrost „z niczego" nie ma procentu, a kontrakt
 * chce liczby, więc neutralna wartość zamiast wymyślonych +100 %.
 */
export function percentChange(current: number, previous: number): number {
  if (!Number.isFinite(previous) || previous === 0) return 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

// ——— kalendarz w strefie Europe/Warsaw ———

const WARSAW = 'Europe/Warsaw';

const WALL_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: WARSAW,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
  hourCycle: 'h23',
});

export type WallClock = {
  year: number;
  /** 0–11, jak w `Date`. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
};

/** Zegar ścienny Warszawy dla chwili `date` (serwer stoi w UTC). */
export function warsawWallClock(date: Date): WallClock {
  const parts: Record<string, number> = {};
  for (const part of WALL_CLOCK.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month - 1,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
    ms: date.getUTCMilliseconds(),
  };
}

function warsawOffsetMs(instant: number): number {
  const wall = warsawWallClock(new Date(instant));
  return (
    Date.UTC(
      wall.year,
      wall.month,
      wall.day,
      wall.hour,
      wall.minute,
      wall.second,
      wall.ms,
    ) - instant
  );
}

/**
 * Chwila, w której zegar w Warszawie pokazuje podaną datę i godzinę.
 * Miesiąc spoza 0–11 przechodzi na sąsiedni rok (jak w `Date.UTC`). Dwa
 * przybliżenia przesunięcia, bo zmiana czasu potrafi leżeć między zgadnięciem
 * a wynikiem.
 */
export function fromWarsawWallClock(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): Date {
  const guess = Date.UTC(year, month, day, hour, minute, second, ms);
  const first = guess - warsawOffsetMs(guess);
  return new Date(guess - warsawOffsetMs(first));
}

/** Północ pierwszego dnia miesiąca w Warszawie. */
export function warsawMonthStart(year: number, month: number): Date {
  return fromWarsawWallClock(year, month, 1);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * „Ten sam dzień miesiąc temu" na zegarze Warszawy; 31 marca → 28/29 lutego.
 */
export function oneMonthEarlier(now: Date): Date {
  const wall = warsawWallClock(now);
  const target = new Date(Date.UTC(wall.year, wall.month - 1, 1));
  const year = target.getUTCFullYear();
  const month = target.getUTCMonth();
  return fromWarsawWallClock(
    year,
    month,
    Math.min(wall.day, daysInMonth(year, month)),
    wall.hour,
    wall.minute,
    wall.second,
    wall.ms,
  );
}

/** Skróty miesięcy jak na osi wykresu w panelu (`'wrz'`). */
export const MONTH_LABELS_PL = [
  'sty',
  'lut',
  'mar',
  'kwi',
  'maj',
  'cze',
  'lip',
  'sie',
  'wrz',
  'paź',
  'lis',
  'gru',
] as const;

/**
 * Punkty wykresu MRR: koniec każdego z ostatnich `months` miesięcy
 * (warszawskich), a dla bieżącego — teraz.
 */
export function mrrSeriesPoints(
  now: Date,
  months = 6,
): { month: string; at: Date }[] {
  const wall = warsawWallClock(now);
  const points: { month: string; at: Date }[] = [];
  for (let back = months - 1; back >= 0; back -= 1) {
    const first = new Date(Date.UTC(wall.year, wall.month - back, 1));
    const year = first.getUTCFullYear();
    const month = first.getUTCMonth();
    points.push({
      month: MONTH_LABELS_PL[month],
      at:
        back === 0
          ? now
          : new Date(warsawMonthStart(year, month + 1).getTime() - 1),
    });
  }
  return points;
}

// ——— ryzyko odejścia ———

export type RiskKind = SubscriptionsData['risk'][number]['kind'];

/** Kolejność ważności: odebrany dostęp, potem łaska, potem brak odnowienia. */
export const RISK_SEVERITY: Record<RiskKind, number> = {
  operatorHold: 0,
  grace: 1,
  autoRenewOff: 2,
};

export type RiskSignal = {
  kind: RiskKind;
  until: Date | null;
  productId: ProductId;
};

/**
 * Czy płacąca subskrypcja jest zagrożona odejściem — i dlaczego:
 *   • `operatorHold` — dostęp odebrany ręcznie, a umowa poza tym żyje
 *     (klient może dalej płacić Apple bez asystenta: reklamacja w drodze);
 *     `until` = `null`, bo blokada nie ma końca,
 *   • `grace` — Apple ponawia płatność; `until` = koniec łaski (z domyślnymi
 *     16 dniami, gdy Apple nie podało daty),
 *   • `autoRenewOff` — klient wyłączył odnowienie; `until` = koniec okresu.
 * Tylko wiersze z przychodem i ze znanym produktem (kontrakt i front znają
 * wyłącznie te trzy).
 */
export function riskSignal(
  row: MetricSubscription,
  now: Date,
): RiskSignal | null {
  if (!carriesRevenue(row) || !isAdminProductId(row.productId)) return null;
  const productId = row.productId;
  if (!liveIgnoringHold(row, now)) return null;
  if (row.operatorHoldAt)
    return { kind: 'operatorHold', until: null, productId };
  if (row.status === 'GRACE') {
    return { kind: 'grace', until: graceEnd(row), productId };
  }
  if (row.autoRenewStatus === false) {
    return { kind: 'autoRenewOff', until: row.expiresAt, productId };
  }
  return null;
}

/** Ważniejszy sygnał wygrywa; przy remisie — bliższy termin. */
export function compareRisk(a: RiskSignal, b: RiskSignal): number {
  const severity = RISK_SEVERITY[a.kind] - RISK_SEVERITY[b.kind];
  if (severity !== 0) return severity;
  const at = a.until?.getTime() ?? Number.POSITIVE_INFINITY;
  const bt = b.until?.getTime() ?? Number.POSITIVE_INFINITY;
  return at === bt ? 0 : at < bt ? -1 : 1;
}
