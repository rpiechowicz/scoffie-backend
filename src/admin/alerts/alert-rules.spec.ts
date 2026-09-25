import type {
  RailwayData,
  RailwayDeploy,
  RailwayService,
  SentryData,
  SentryIssue,
  SentryProjectHealth,
} from '../contract';
import {
  crashFreeAlerts,
  domainAlerts,
  mailFailedAlerts,
  mailQueueAlerts,
  planAlerts,
  railwayAlerts,
  sentryFatalAlerts,
  type Detection,
  type StoredAlert,
} from './alert-rules';

const NOW = new Date('2026-09-25T10:00:00.000Z');

const deploy = (id: string, status: string): RailwayDeploy => ({
  id,
  status,
  createdAt: '2026-09-25T09:00:00.000Z',
  commitHash: 'abcdef1234',
  commitMessage: 'fix',
  branch: 'main',
  statusUpdatedAt: null,
  author: 'Rafał',
  reason: 'deploy',
});

const service = (
  id: string,
  deploys: RailwayDeploy[],
  cron: string | null = null,
): RailwayService => ({
  id,
  name: id === 's1' ? 'scoffie-backend' : 'db-backup',
  cron,
  nextCronRunAt: null,
  region: null,
  replicas: 1,
  deploys,
  cpu: [],
  memoryGb: [],
  url: 'https://railway.com',
});

const railway = (...services: RailwayService[]): RailwayData => ({ services });

const project = (
  slug: string,
  crashFreeSessions: number | null,
): SentryProjectHealth => ({
  slug,
  crashFreeUsers: null,
  crashFreeSessions,
  unresolved: 0,
  new24h: 0,
  events24h: null,
  release: null,
});

const issue = (id: string, level: string, firstSeen: string): SentryIssue => ({
  id,
  shortId: `SCOFFIE-IOS-${id}`,
  title: 'Fatal error: jan.kowalski@example.com',
  culprit: 'PlanView.body',
  level,
  project: 'scoffie-ios',
  count: 7,
  userCount: 3,
  firstSeen,
  lastSeen: NOW.toISOString(),
  permalink: 'https://sentry.io',
});

const sentry = (
  projects: SentryProjectHealth[],
  issues: SentryIssue[] = [],
): SentryData => ({ projects, issues, url: '', missing: [] });

/** Symulacja kolejnych przebiegów na „bazie” w pamięci. */
function simulate(rounds: Detection[][]): StoredAlert[][] {
  let rows: StoredAlert[] = [];
  let n = 0;
  const history: StoredAlert[][] = [];
  for (const detections of rounds) {
    const plan = planAlerts(rows, detections);
    rows = rows.map((row) => {
      if (plan.resolve.some((r) => r.id === row.id)) {
        return { ...row, resolvedAt: NOW };
      }
      if (plan.reopen.some((r) => r.row.id === row.id)) {
        return { ...row, resolvedAt: null };
      }
      return row;
    });
    for (const alert of plan.open) {
      rows.push({
        id: `id${++n}`,
        key: alert.key,
        kind: alert.kind,
        resolvedAt: null,
      });
    }
    history.push(rows.map((r) => ({ ...r })));
  }
  return history;
}

describe('Railway: wdrożenie FAILED/CRASHED', () => {
  it('wykrywa ostatnie padnięte wdrożenie, starsze porażki ignoruje', () => {
    const alerts = railwayAlerts(
      railway(
        service('s1', [deploy('d2', 'CRASHED'), deploy('d1', 'SUCCESS')]),
        service('s2', [deploy('d4', 'SUCCESS'), deploy('d3', 'FAILED')]),
      ),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      key: 'deploy-failed:s1:d2',
      severity: 'critical',
      title: 'scoffie-backend: wdrożenie padło',
    });
    // Autor commita to dane osoby — nie idzie do treści.
    expect(alerts[0].detail).not.toContain('Rafał');
  });

  it('cron dostaje „uruchomienie”, nie „wdrożenie”', () => {
    const [alert] = railwayAlerts(
      railway(service('s2', [deploy('d9', 'FAILED')], '0 3 * * *')),
    );
    expect(alert.title).toBe('db-backup: uruchomienie padło');
  });

  it('nie dubluje i rozwiązuje, gdy kolejne wdrożenie przejdzie', () => {
    const failed = railway(service('s1', [deploy('d2', 'FAILED')]));
    const fixed = railway(
      service('s1', [deploy('d3', 'SUCCESS'), deploy('d2', 'FAILED')]),
    );
    const history = simulate([
      [{ kind: 'deploy-failed', problems: railwayAlerts(failed) }],
      [{ kind: 'deploy-failed', problems: railwayAlerts(failed) }],
      [{ kind: 'deploy-failed', problems: railwayAlerts(fixed) }],
    ]);
    expect(history[0]).toHaveLength(1);
    expect(history[1]).toHaveLength(1);
    expect(history[2][0].resolvedAt).toEqual(NOW);
  });
});

describe('Sentry: crash-free iOS', () => {
  it('wykrywa spadek poniżej 99 %, a poniżej 97 % jest krytyczny', () => {
    expect(crashFreeAlerts(sentry([project('scoffie-ios', 99.5)]))).toEqual([]);
    const [warning] = crashFreeAlerts(sentry([project('scoffie-ios', 98.4)]));
    expect(warning).toMatchObject({
      key: 'crash-free:scoffie-ios',
      severity: 'warning',
    });
    expect(warning.detail).toContain('98,40 %');
    expect(
      crashFreeAlerts(sentry([project('scoffie-ios', 95)]))[0].severity,
    ).toBe('critical');
  });

  it('brak sesji to nie 0 % — bez alertu', () => {
    expect(crashFreeAlerts(sentry([project('scoffie-ios', null)]))).toEqual([]);
    expect(crashFreeAlerts(sentry([project('scoffie-backend', 50)]))).toEqual(
      [],
    );
  });

  it('nie dubluje i rozwiązuje po powrocie ponad próg', () => {
    const low = sentry([project('scoffie-ios', 98)]);
    const ok = sentry([project('scoffie-ios', 99.9)]);
    const history = simulate([
      [{ kind: 'crash-free', problems: crashFreeAlerts(low) }],
      [{ kind: 'crash-free', problems: crashFreeAlerts(low) }],
      [{ kind: 'crash-free', problems: crashFreeAlerts(ok) }],
      [{ kind: 'crash-free', problems: crashFreeAlerts(low) }],
    ]);
    expect(history[1]).toHaveLength(1);
    expect(history[2][0].resolvedAt).toEqual(NOW);
    // Powrót to ten sam wiersz otwarty ponownie, nie drugi.
    expect(history[3]).toHaveLength(1);
    expect(history[3][0].resolvedAt).toBeNull();
  });
});

describe('Sentry: nowe problemy fatal', () => {
  it('bierze tylko fatal z pierwszym wystąpieniem w 24 h, bez tytułu błędu', () => {
    const alerts = sentryFatalAlerts(
      sentry(
        [],
        [
          issue('1', 'fatal', '2026-09-25T08:00:00.000Z'),
          issue('2', 'error', '2026-09-25T08:00:00.000Z'),
          issue('3', 'fatal', '2026-09-20T08:00:00.000Z'),
        ],
      ),
      NOW,
    );
    expect(alerts.map((a) => a.key)).toEqual(['sentry-fatal:1']);
    expect(alerts[0].title).toBe('Nowy crash SCOFFIE-IOS-1');
    // Tytuł z Sentry potrafi nieść adres — do treści idzie miejsce w kodzie.
    expect(alerts[0].detail).not.toContain('@');
    expect(alerts[0].detail).toContain('PlanView.body');
  });

  it('rozwiązuje, gdy problem zniknie z listy', () => {
    const fresh = sentry([], [issue('1', 'fatal', '2026-09-25T08:00:00.000Z')]);
    const history = simulate([
      [{ kind: 'sentry-fatal', problems: sentryFatalAlerts(fresh, NOW) }],
      [{ kind: 'sentry-fatal', problems: sentryFatalAlerts(fresh, NOW) }],
      [{ kind: 'sentry-fatal', problems: sentryFatalAlerts(sentry([]), NOW) }],
    ]);
    expect(history[1]).toHaveLength(1);
    expect(history[2][0].resolvedAt).toEqual(NOW);
  });
});

describe('Poczta', () => {
  const waiting = (minutes: number) =>
    new Date(NOW.getTime() - minutes * 60_000);

  it('kolejka stoi dopiero po 15 minutach i tylko przy włączonej poczcie', () => {
    expect(
      mailQueueAlerts({
        mailEnabled: true,
        oldestWaitingSince: waiting(14),
        now: NOW,
      }),
    ).toEqual([]);
    const [stuck] = mailQueueAlerts({
      mailEnabled: true,
      oldestWaitingSince: waiting(20),
      now: NOW,
    });
    expect(stuck).toMatchObject({
      key: 'mail-queue-stuck',
      severity: 'critical',
    });
    expect(stuck.detail).toContain('20 min');
    expect(
      mailQueueAlerts({
        mailEnabled: false,
        oldestWaitingSince: waiting(60),
        now: NOW,
      }),
    ).toEqual([]);
    expect(
      mailQueueAlerts({
        mailEnabled: true,
        oldestWaitingSince: null,
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('FAILED z 24 h: wykrywa, odświeża liczbę zamiast dublować, rozwiązuje', () => {
    expect(mailFailedAlerts(0)).toEqual([]);
    expect(mailFailedAlerts(2)[0].detail).toContain('2 maile');
    expect(mailFailedAlerts(5)[0].detail).toContain('5 maili');
    const history = simulate([
      [{ kind: 'mail-failed', problems: mailFailedAlerts(1) }],
      [{ kind: 'mail-failed', problems: mailFailedAlerts(3) }],
      [{ kind: 'mail-failed', problems: mailFailedAlerts(0) }],
    ]);
    expect(history[1]).toHaveLength(1);
    expect(history[2][0].resolvedAt).toEqual(NOW);
  });

  it('domena inna niż verified to alert; zweryfikowana go zamyka', () => {
    const bad = [{ name: 'scoffie.app', status: 'failed', region: null }];
    const good = [{ name: 'scoffie.app', status: 'verified', region: null }];
    expect(domainAlerts(bad)[0]).toMatchObject({
      key: 'mail-domain:scoffie.app',
      severity: 'critical',
    });
    const history = simulate([
      [{ kind: 'mail-domain', problems: domainAlerts(bad) }],
      [{ kind: 'mail-domain', problems: domainAlerts(bad) }],
      [{ kind: 'mail-domain', problems: domainAlerts(good) }],
    ]);
    expect(history[1]).toHaveLength(1);
    expect(history[2][0].resolvedAt).toEqual(NOW);
  });
});

describe('planAlerts', () => {
  it('reguła, która się nie wykonała, nie zamyka swoich alertów', () => {
    const stored: StoredAlert[] = [
      {
        id: 'a',
        key: 'crash-free:scoffie-ios',
        kind: 'crash-free',
        resolvedAt: null,
      },
    ];
    // Sentry nie odpowiedział — w wyniku jest tylko poczta.
    const plan = planAlerts(stored, [{ kind: 'mail-failed', problems: [] }]);
    expect(plan.resolve).toEqual([]);
  });

  it('otwarty i widziany dalej to tylko odświeżenie (bez powiadomienia)', () => {
    const stored: StoredAlert[] = [
      { id: 'a', key: 'mail-failed', kind: 'mail-failed', resolvedAt: null },
    ];
    const plan = planAlerts(stored, [
      { kind: 'mail-failed', problems: mailFailedAlerts(4) },
    ]);
    expect(plan.open).toEqual([]);
    expect(plan.reopen).toEqual([]);
    expect(plan.touch).toHaveLength(1);
  });
});
