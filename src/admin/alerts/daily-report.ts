import { REFERENCE_USD_PLN } from '../../config/ai-unit-economics';
import type {
  DailyReportMetric,
  DailyReportPayload,
} from '../../mail/mail-template';
import {
  addDays,
  warsawDateKey,
  warsawDayStart,
  warsawWallClock,
  type PanelDay,
} from '../common/warsaw-calendar';
import type { DayStat } from '../contract';
import { mrrSeries, paidCounts } from '../users/admin-metrics';
import {
  carriesRevenue,
  endedAt,
  type MetricSubscription,
} from '../subscriptions/subscription-metrics';

/**
 * Raport „Scoffie wczoraj” — czyste funkcje (pora wysyłki, doby, treść),
 * testowane bez bazy i bez zegara. Dane zbiera `AdminDailyReportService`.
 */

/** Godzina wysyłki na zegarze w Warszawie. */
export const REPORT_HOUR = 7;

/** Prefiks `MailMessage.dedupeKey` — „tylko raz na dobę”, także po restarcie. */
export const REPORT_DEDUPE_PREFIX = 'daily-report:';

/**
 * Za jaką dobę raport jest już należny: od 7:00 w Warszawie — za wczoraj,
 * przed 7:00 — jeszcze za nic (`null`). Zegar ścienny, nie „UTC + 2”:
 * po zmianie czasu 7:00 to raz 5:00, raz 6:00 UTC.
 *
 * Backend, który wstanie po 7:00, wyśle zaległy raport od razu (tylko za
 * wczoraj — przedwczorajszego nikt już nie potrzebuje).
 */
export function dueReportDay(now: Date): string | null {
  if (warsawWallClock(now).hour < REPORT_HOUR) return null;
  return addDays(warsawDateKey(now), -1);
}

/** Doba raportu i dzień przed nią, od starszej. */
export function reportPanelDays(day: string): PanelDay[] {
  return [addDays(day, -1), day].map((key) => ({
    key,
    start: warsawDayStart(key),
    end: warsawDayStart(addDays(key, 1)),
  }));
}

/** Koniec doby (ostatnia milisekunda), ale nie później niż teraz. */
export function endOfDay(day: PanelDay, now: Date): Date {
  return new Date(Math.min(day.end.getTime() - 1, now.getTime()));
}

export type ReportCounts = {
  /** Osoby z co najmniej jedną turą asystenta w dobie (`AgentTurn.userId`). */
  assistantUsers: number;
  mailsSent: number;
  mailsFailed: number;
  reports: number;
};

export type ReportInput = {
  days: PanelDay[];
  now: Date;
  panelUrl: string;
  /** `AdminDashboardService.reportDays` — ta sama arytmetyka co pulpit. */
  stats: DayStat[];
  subscriptions: MetricSubscription[];
  /** po jednym na dobę z `days` */
  counts: ReportCounts[];
  openAlerts: number;
  /** Nowe problemy Sentry z 24 h (suma projektów); `null` — Sentry niepodłączony albo nie odpowiedział. */
  sentryNew24h: number | null;
  /** Ostatnie uruchomienie `db-backup` z Railwaya; `null` — brak tokenu albo usługi. */
  backup: { status: string; startedAt: string } | null;
  /** USD/PLN z NBP na dobę raportu (`FxRateService.usdPlnOn`); brak — stała cennika. */
  usdPln?: number;
};

const metric = (
  label: string,
  values: number[],
  format: DailyReportMetric['format'],
  good: DailyReportMetric['good'],
): DailyReportMetric => ({
  label,
  value: values[1],
  previous: values[0],
  format,
  good,
});

const round2 = (n: number) => Math.round(n * 100) / 100;

export function buildReportPayload(input: ReportInput): DailyReportPayload {
  const { days, now, stats, subscriptions, counts } = input;
  const points = days.map((d) => endOfDay(d, now));
  const mrr = mrrSeries(subscriptions, points, now);
  const paid = paidCounts(subscriptions, points);
  const revenue = subscriptions.filter(carriesRevenue);
  const inDay = (at: Date | null, d: PanelDay) =>
    at !== null &&
    at.getTime() >= d.start.getTime() &&
    at.getTime() < d.end.getTime();
  const newSubs = days.map(
    (d) => revenue.filter((row) => inDay(row.createdAt, d)).length,
  );
  const churned = days.map(
    (d) =>
      revenue.filter(
        (row) =>
          (row.status === 'EXPIRED' || row.status === 'REVOKED') &&
          inDay(endedAt(row, now), d),
      ).length,
  );
  const cost = stats.map((s) => round2(s.aiCostUsd));

  const operations: DailyReportMetric[] = [
    metric(
      'Maile wysłane',
      counts.map((c) => c.mailsSent),
      'count',
      'neutral',
    ),
    metric(
      'Maile nieudane',
      counts.map((c) => c.mailsFailed),
      'count',
      'down',
    ),
    metric(
      'Nowe zgłoszenia',
      counts.map((c) => c.reports),
      'count',
      'down',
    ),
  ];
  if (input.sentryNew24h !== null) {
    operations.push({
      label: 'Nowe problemy Sentry (24 h)',
      value: input.sentryNew24h,
      previous: null,
      format: 'count',
      good: 'down',
    });
  }

  const notes: DailyReportPayload['notes'] = [
    input.openAlerts > 0
      ? {
          tone: 'warn',
          text: `Otwarte alerty: ${input.openAlerts}. Szczegóły na ekranie Alerty.`,
        }
      : { tone: 'ok', text: 'Brak otwartych alertów.' },
  ];
  if (input.backup) {
    const at = `${input.backup.startedAt.slice(0, 16).replace('T', ' ')} UTC`;
    notes.push(
      input.backup.status === 'EXITED'
        ? {
            tone: 'ok',
            text: `Kopia bazy: ostatnie uruchomienie ${at} zakończone.`,
          }
        : {
            tone: 'warn',
            text: `Kopia bazy: ostatnie uruchomienie ${at} ma status ${input.backup.status}.`,
          },
    );
  }

  return {
    day: days[1].key,
    panelUrl: input.panelUrl,
    sections: [
      {
        title: 'Ludzie',
        metrics: [
          metric(
            'Nowe konta',
            stats.map((s) => s.newUsers),
            'count',
            'up',
          ),
          metric(
            'Osoby z asystentem',
            counts.map((c) => c.assistantUsers),
            'count',
            'up',
          ),
          metric(
            'Dania dodane do planów',
            stats.map((s) => s.planItems),
            'count',
            'up',
          ),
        ],
      },
      {
        title: 'Asystent',
        metrics: [
          metric(
            'Tury asystenta',
            stats.map((s) => s.turns),
            'count',
            'neutral',
          ),
          metric('Koszt AI', cost, 'usd', 'down'),
          // Kurs NBP z doby raportu (ostatnie notowanie), bez niego stała
          // cennika z `ai-unit-economics.ts` — to przybliżenie, nie kurs z faktury.
          metric(
            'Koszt AI w złotych',
            cost.map((c) => round2(c * (input.usdPln ?? REFERENCE_USD_PLN))),
            'pln',
            'down',
          ),
        ],
      },
      {
        title: 'Subskrypcje',
        metrics: [
          metric('MRR', mrr, 'pln', 'up'),
          metric('Opłacone subskrypcje', paid, 'count', 'up'),
          metric('Nowe subskrypcje', newSubs, 'count', 'up'),
          metric('Odejścia', churned, 'count', 'down'),
        ],
      },
      { title: 'Operacje', metrics: operations },
    ],
    notes,
  };
}
