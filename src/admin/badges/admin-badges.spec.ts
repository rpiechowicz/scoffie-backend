import type { PrismaService } from '../../prisma/prisma.service';
import type {
  CronRun,
  RailwayData,
  RailwayDeploy,
  RailwayService,
} from '../contract';
import {
  DeployTrackerService,
  type KnownService,
} from '../integrations/deploy-tracker.service';
import { AdminBadgesService, CLAUDE_LOW_KIND } from './admin-badges.service';
import { serviceDown, systemBadge } from './badges-rules';

const deploy = (id: string, status: string): RailwayDeploy => ({
  id,
  status,
  createdAt: '2026-09-26T10:00:00.000Z',
  commitHash: 'abc1234',
  commitMessage: 'fix: coś',
  branch: 'main',
  statusUpdatedAt: null,
  author: null,
  reason: 'deploy',
});

const run = (status: string): CronRun => ({
  id: `run-${status}`,
  status,
  startedAt: '2026-09-26T03:15:00.000Z',
  finishedAt: null,
});

const svc = (
  id: string,
  deploys: RailwayDeploy[],
  cron: string | null = null,
  runs: CronRun[] = [],
): KnownService => ({ id, name: id, cron, runs, deploys });

describe('liczniki panelu — reguła „padła”', () => {
  it('usługa bez crona: ostatnie wdrożenie FAILED albo CRASHED', () => {
    expect(serviceDown(svc('a', [deploy('1', 'FAILED')]))).toBe(true);
    expect(serviceDown(svc('a', [deploy('1', 'CRASHED')]))).toBe(true);
    expect(serviceDown(svc('a', [deploy('1', 'SUCCESS')]))).toBe(false);
    expect(serviceDown(svc('a', []))).toBe(false);
  });

  it('cron z historią: liczy się ostatnie uruchomienie z wynikiem, nie CRASHED wdrożenia', () => {
    const ok = [run('RUNNING'), run('EXITED'), run('CRASHED')];
    expect(
      serviceDown(svc('c', [deploy('1', 'CRASHED')], '0 3 * * *', ok)),
    ).toBe(false);
    const bad = [run('CRASHED'), run('EXITED')];
    expect(
      serviceDown(svc('c', [deploy('1', 'SUCCESS')], '0 3 * * *', bad)),
    ).toBe(true);
    // nieudana budowa crona to awaria nawet przy udanym ostatnim uruchomieniu
    expect(
      serviceDown(svc('c', [deploy('1', 'FAILED')], '0 3 * * *', ok)),
    ).toBe(true);
  });

  it('cron bez historii: jak zwykła usługa', () => {
    expect(
      serviceDown(
        svc('c', [deploy('1', 'CRASHED')], '0 3 * * *', [run('RUNNING')]),
      ),
    ).toBe(true);
  });

  it('systemBadge: liczba padniętych i wdrożenie w toku; bez stanu — null', () => {
    expect(systemBadge(null)).toBeNull();
    expect(
      systemBadge([
        svc('a', [deploy('1', 'FAILED')]),
        svc('b', [deploy('2', 'BUILDING'), deploy('3', 'SUCCESS')]),
        svc('c', [deploy('4', 'SUCCESS')]),
      ]),
    ).toEqual({ down: 1, deploying: true });
    expect(systemBadge([svc('c', [deploy('4', 'SUCCESS')])])).toEqual({
      down: 0,
      deploying: false,
    });
  });
});

describe('liczniki panelu — ostatni znany stan Railwaya', () => {
  const full = (services: RailwayService[]): RailwayData =>
    ({ services }) as unknown as RailwayData;
  const railwayService = (id: string, deploys: RailwayDeploy[]) =>
    ({
      id,
      name: id,
      cron: null,
      runs: [],
      deploys,
    }) as unknown as RailwayService;

  function tracker(now: () => number) {
    const t = new DeployTrackerService();
    t.timers = false;
    t.io = { ...t.io, now, emit: () => undefined };
    return t;
  }

  it('bez żadnego odczytu — null (tuż po starcie procesu)', () => {
    expect(tracker(() => 1000).lastKnown()).toBeNull();
  });

  it('pełny odczyt, na nim świeższe wdrożenie ze śledzenia', () => {
    let now = 1000;
    const t = tracker(() => now);
    t.remember(full([railwayService('api', [deploy('d1', 'SUCCESS')])]), 1000);
    now = 2000;
    t.observe([
      {
        serviceId: 'api',
        serviceName: 'api',
        deploy: deploy('d2', 'BUILDING'),
      },
    ]);
    const known = t.lastKnown();
    expect(known?.[0]?.deploys.map((d) => `${d.id}:${d.status}`)).toEqual([
      'd2:BUILDING',
      'd1:SUCCESS',
    ]);
    expect(systemBadge(known)).toEqual({ down: 0, deploying: true });
  });

  it('starszy pełny odczyt (z pamięci na minutę) nie nadpisuje nowszego', () => {
    const t = tracker(() => 5000);
    t.remember(full([railwayService('api', [deploy('d2', 'FAILED')])]), 4000);
    t.remember(full([railwayService('api', [deploy('d1', 'SUCCESS')])]), 3000);
    expect(systemBadge(t.lastKnown())).toEqual({ down: 1, deploying: false });
  });

  it('pełny odczyt nowszy od śledzenia — śledzenie nie cofa stanu', () => {
    let now = 1000;
    const t = tracker(() => now);
    t.observe([
      {
        serviceId: 'api',
        serviceName: 'api',
        deploy: deploy('d1', 'BUILDING'),
      },
    ]);
    now = 2000;
    t.remember(full([railwayService('api', [deploy('d1', 'SUCCESS')])]), 2000);
    expect(systemBadge(t.lastKnown())).toEqual({ down: 0, deploying: false });
  });

  it('samo śledzenie, bez pełnego odczytu — usługi z najnowszym wdrożeniem', () => {
    const t = tracker(() => 1000);
    t.observe([
      { serviceId: 'api', serviceName: 'api', deploy: deploy('d1', 'CRASHED') },
    ]);
    expect(systemBadge(t.lastKnown())).toEqual({ down: 1, deploying: false });
  });
});

describe('liczniki panelu — serwis', () => {
  function prisma() {
    const counts = {
      agentReport: jest.fn(() => Promise.resolve(3)),
      adminAlert: jest.fn((args: { where: Record<string, unknown> }) =>
        Promise.resolve(
          args.where.kind === CLAUDE_LOW_KIND
            ? 1
            : args.where.severity === 'critical'
              ? 1
              : 2,
        ),
      ),
      mailMessage: jest.fn(() => Promise.resolve(4)),
      subscription: jest.fn(() => Promise.resolve(5)),
      gdprRequest: jest.fn((args: { where: { dueAt: Record<string, Date> } }) =>
        Promise.resolve('gte' in args.where.dueAt ? 6 : 7),
      ),
    };
    const client = Object.fromEntries(
      Object.entries(counts).map(([k, count]) => [k, { count }]),
    ) as unknown as PrismaService;
    return { client, counts };
  }

  it('OWNER: wszystkie liczniki, stan Railwaya z pamięci bez pytania', async () => {
    const { client } = prisma();
    const t = new DeployTrackerService();
    t.timers = false;
    const load = jest.fn();
    t.io = { ...t.io, now: () => 1000, load, emit: () => undefined };
    t.observe([
      {
        serviceId: 'api',
        serviceName: 'api',
        deploy: deploy('d1', 'DEPLOYING'),
      },
    ]);
    const badges = await new AdminBadgesService(client, t).badges(
      'OWNER',
      new Date('2026-09-26T12:00:00Z'),
    );
    expect(badges).toEqual({
      reports: 3,
      alerts: { open: 2, critical: 1 },
      mailsFailed: 4,
      subsInGrace: 5,
      gdpr: { overdue: 7, dueSoon: 6 },
      system: { down: 0, deploying: true },
      claudeLow: true,
    });
    expect(load).not.toHaveBeenCalled();
  });

  it('rola bez uprawnień: same null i żadnego zapytania do bazy', async () => {
    const { client, counts } = prisma();
    const t = new DeployTrackerService();
    t.timers = false;
    const badges = await new AdminBadgesService(client, t).badges('NIKT');
    expect(Object.values(badges).every((v) => v === null)).toBe(true);
    for (const count of Object.values(counts))
      expect(count).not.toHaveBeenCalled();
  });

  it('OWNER tuż po starcie: system null, reszta z bazy', async () => {
    const { client } = prisma();
    const t = new DeployTrackerService();
    t.timers = false;
    const badges = await new AdminBadgesService(client, t).badges('OWNER');
    expect(badges.system).toBeNull();
    expect(badges.reports).toBe(3);
  });
});
