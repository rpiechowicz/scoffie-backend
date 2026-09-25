import type { MetricSubscription } from '../subscriptions/subscription-metrics';
import { readAlertsEnv } from './alerts-env';
import {
  buildReportPayload,
  dueReportDay,
  reportPanelDays,
} from './daily-report';

describe('pora raportu: 7:00 w Warszawie', () => {
  it('czas letni: 7:00 to 5:00 UTC', () => {
    expect(dueReportDay(new Date('2026-09-25T04:59:00.000Z'))).toBeNull();
    expect(dueReportDay(new Date('2026-09-25T05:00:00.000Z'))).toBe(
      '2026-09-24',
    );
  });

  it('czas zimowy: 7:00 to 6:00 UTC', () => {
    expect(dueReportDay(new Date('2026-11-10T05:30:00.000Z'))).toBeNull();
    expect(dueReportDay(new Date('2026-11-10T06:00:00.000Z'))).toBe(
      '2026-11-09',
    );
  });

  it('w dniu zmiany czasu (25.10.2026) liczy zegar ścienny, a raport dotyczy soboty', () => {
    // 3:00 CEST → 2:00 CET o 1:00 UTC; 7:00 CET = 6:00 UTC.
    expect(dueReportDay(new Date('2026-10-25T05:30:00.000Z'))).toBeNull();
    expect(dueReportDay(new Date('2026-10-25T06:00:00.000Z'))).toBe(
      '2026-10-24',
    );
  });

  it('wieczorem dalej za wczoraj; po północy UTC, ale przed 7:00 — nic', () => {
    expect(dueReportDay(new Date('2026-09-25T21:30:00.000Z'))).toBe(
      '2026-09-24',
    );
    // 23:30 UTC 25.09 = 1:30 26.09 w Warszawie — przed siódmą.
    expect(dueReportDay(new Date('2026-09-25T23:30:00.000Z'))).toBeNull();
  });

  it('doba zmiany czasu ma 25 godzin', () => {
    const [, day] = reportPanelDays('2026-10-25');
    expect(day.end.getTime() - day.start.getTime()).toBe(25 * 3_600_000);
    expect(day.start.toISOString()).toBe('2026-10-24T22:00:00.000Z');
  });
});

describe('odbiorcy', () => {
  it('pusta lista alertów = pierwszy adres właściciela; raport = jak alerty', () => {
    const env = readAlertsEnv({
      ADMIN_BOOTSTRAP_EMAIL: 'Rafal@Example.com, rafal@icloud.com',
    });
    expect(env.alertEmails).toEqual(['rafal@example.com']);
    expect(env.reportEmails).toEqual(['rafal@example.com']);
    expect(env.enabled).toBe(true);
    expect(env.reportEnabled).toBe(false);
    expect(env.panelUrl).toBe('https://dashboard.scoffie.app');
  });

  it('jawne listy wygrywają, śmieci i powtórzenia odpadają', () => {
    const env = readAlertsEnv({
      ADMIN_BOOTSTRAP_EMAIL: 'owner@example.com',
      ADMIN_ALERT_EMAILS: 'a@x.pl, nie-adres, A@x.pl ,b@y.pl',
      ADMIN_REPORT_EMAILS: 'r@z.pl',
      ADMIN_DAILY_REPORT: 'true',
      ADMIN_ALERTS: 'false',
      ADMIN_WEBAUTHN_ORIGIN: 'https://panel.test/',
    });
    expect(env.alertEmails).toEqual(['a@x.pl', 'b@y.pl']);
    expect(env.reportEmails).toEqual(['r@z.pl']);
    expect(env.reportEnabled).toBe(true);
    expect(env.enabled).toBe(false);
    expect(env.panelUrl).toBe('https://panel.test');
  });

  it('bez właściciela i bez list — nikt (nie zgadujemy adresu)', () => {
    expect(readAlertsEnv({}).alertEmails).toEqual([]);
  });
});

describe('treść raportu', () => {
  const days = reportPanelDays('2026-09-24');
  const now = new Date('2026-09-25T05:00:00.000Z');
  const sub = (over: Partial<MetricSubscription>): MetricSubscription => ({
    id: 's',
    provider: 'APPLE',
    productId: 'app.scoffie.pro.solo.monthly',
    status: 'ACTIVE',
    environment: 'Production',
    ownershipType: 'PURCHASED',
    expiresAt: new Date('2026-10-20T00:00:00.000Z'),
    graceExpiresAt: null,
    neverExpires: false,
    revokedAt: null,
    operatorHoldAt: null,
    autoRenewStatus: true,
    messagesLimitSnapshot: null,
    plansLimitSnapshot: null,
    purchaserUserId: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...over,
  });

  const payload = buildReportPayload({
    days,
    now,
    panelUrl: 'https://dashboard.scoffie.app',
    stats: [
      { date: '', newUsers: 3, turns: 10, planItems: 5, aiCostUsd: 1.004 },
      { date: '', newUsers: 5, turns: 12, planItems: 7, aiCostUsd: 2 },
    ],
    subscriptions: [
      sub({ id: 'old' }),
      // Nowa wczoraj (24.09 12:00 w Warszawie).
      sub({ id: 'new', createdAt: new Date('2026-09-24T10:00:00.000Z') }),
      // Odeszła przedwczoraj.
      sub({
        id: 'gone',
        status: 'EXPIRED',
        expiresAt: new Date('2026-09-23T10:00:00.000Z'),
        updatedAt: new Date('2026-09-23T10:00:00.000Z'),
      }),
    ],
    counts: [
      { assistantUsers: 4, mailsSent: 2, mailsFailed: 0, reports: 1 },
      { assistantUsers: 6, mailsSent: 3, mailsFailed: 1, reports: 0 },
    ],
    openAlerts: 2,
    sentryNew24h: null,
  });
  const find = (label: string) =>
    payload.sections.flatMap((s) => s.metrics).find((m) => m.label === label);

  it('wczoraj vs przedwczoraj z serii pulpitu', () => {
    expect(payload.day).toBe('2026-09-24');
    expect(find('Nowe konta')).toMatchObject({ value: 5, previous: 3 });
    expect(find('Koszt AI')).toMatchObject({ value: 2, previous: 1 });
    expect(find('Osoby z asystentem')).toMatchObject({ value: 6, previous: 4 });
    expect(find('Maile nieudane')).toMatchObject({ value: 1, previous: 0 });
  });

  it('subskrypcje: MRR, nowe i odejścia per doba', () => {
    expect(find('Nowe subskrypcje')).toMatchObject({ value: 1, previous: 0 });
    expect(find('Odejścia')).toMatchObject({ value: 0, previous: 1 });
    const mrr = find('MRR');
    expect(mrr!.value).toBeGreaterThan(mrr!.previous!);
    expect(find('Opłacone subskrypcje')).toMatchObject({
      value: 2,
      previous: 1,
    });
  });

  it('bez Sentry nie ma wiersza Sentry; otwarte alerty w uwagach', () => {
    expect(find('Nowe problemy Sentry (24 h)')).toBeUndefined();
    expect(payload.notes).toEqual([
      { tone: 'warn', text: 'Otwarte alerty: 2. Szczegóły na ekranie Alerty.' },
    ]);
  });
});
