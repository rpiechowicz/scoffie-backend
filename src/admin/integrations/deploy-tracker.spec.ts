import { NotFoundException } from '@nestjs/common';
import type { LiveEvent } from '../../common/live-events';
import { redactUrl } from '../../common/redact-url';
import type { RailwayDeploy } from '../contract';
import {
  DeployTrackerService,
  FOLLOW_MS,
  MAX_TRACK_MS,
  MIN_GAP_MS,
} from './deploy-tracker.service';
import { IntegrationCache } from './integration-fetch';
import type { LatestDeploy } from './railway.client';
import {
  RailwayWebhookController,
  sameSecret,
} from './railway-webhook.controller';

const deploy = (
  id: string,
  status: string,
  message = 'fix: coś',
): RailwayDeploy => ({
  id,
  status,
  createdAt: '2026-09-26T10:00:00.000Z',
  commitHash: 'abc1234',
  commitMessage: `${message}\n\nszczegóły`,
  branch: 'main',
  statusUpdatedAt: null,
  author: null,
  reason: 'deploy',
});

const api = (d: RailwayDeploy | null): LatestDeploy => ({
  serviceId: 'svc-api',
  serviceName: 'api',
  deploy: d,
});

/** Tracker z ręcznym zegarem i timerami; `answers` — kolejne odpowiedzi Railwaya. */
function setup(answers: (LatestDeploy[] | Error)[]) {
  let now = 1_000_000;
  const events: LiveEvent[] = [];
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const load = jest.fn(() => {
    const next = answers.shift();
    if (!next) throw new Error('nieoczekiwane pytanie do Railwaya');
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  const tracker = new DeployTrackerService();
  tracker.timers = true;
  tracker.io = {
    now: () => now,
    load,
    emit: (e) => events.push(e),
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimeout: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  /** Przesuwa zegar i odpala dojrzałe timery (po kolei, z mikrozadaniami). */
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const due = timers[0];
      if (!due || due.at > until) break;
      timers.shift();
      now = due.at;
      due.fn();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }
    now = until;
  };
  return { tracker, events, timers, load, advance };
}

describe('DeployTrackerService', () => {
  it('zlewa serię szturchnięć w jedno pytanie', async () => {
    const t = setup([[api(deploy('d1', 'SUCCESS'))]]);
    t.tracker.poke();
    t.tracker.poke();
    t.tracker.poke();
    await t.advance(0);
    expect(t.load).toHaveBeenCalledTimes(1);
  });

  it('kolejne szturchnięcie najwcześniej po 3 s', async () => {
    const t = setup([
      [api(deploy('d1', 'SUCCESS'))],
      [api(deploy('d1', 'SUCCESS'))],
    ]);
    t.tracker.poke();
    await t.advance(0);
    t.tracker.poke();
    await t.advance(MIN_GAP_MS - 1);
    expect(t.load).toHaveBeenCalledTimes(1);
    await t.advance(1);
    expect(t.load).toHaveBeenCalledTimes(2);
  });

  it('bez zmiany stanu — bez sygnału', async () => {
    const t = setup([
      [api(deploy('d1', 'SUCCESS'))],
      [api(deploy('d1', 'SUCCESS'))],
    ]);
    await t.tracker.run();
    await t.advance(MIN_GAP_MS);
    await t.tracker.run();
    expect(t.events).toEqual([]);
  });

  it('nowe wdrożenie → sygnał ops i śledzenie co 8 s aż do wyniku z powiadomieniem', async () => {
    const t = setup([
      [api(deploy('d1', 'SUCCESS'))],
      [api(deploy('d2', 'BUILDING', 'feat: panel'))],
      [api(deploy('d2', 'BUILDING', 'feat: panel'))],
      [api(deploy('d2', 'DEPLOYING', 'feat: panel'))],
      [api(deploy('d2', 'SUCCESS', 'feat: panel'))],
    ]);
    await t.tracker.run();
    expect(t.events).toEqual([]);

    await t.advance(MIN_GAP_MS);
    t.tracker.poke(); // webhook: Deployment.building
    await t.advance(0);
    expect(t.events).toEqual([{ topics: ['ops'] }]);

    await t.advance(FOLLOW_MS); // dalej BUILDING — cisza
    expect(t.events).toHaveLength(1);
    await t.advance(FOLLOW_MS); // DEPLOYING
    expect(t.events).toHaveLength(2);
    await t.advance(FOLLOW_MS); // SUCCESS
    expect(t.events[2]).toEqual({
      topics: ['ops'],
      notice: {
        level: 'success',
        title: 'api — wdrożenie udane',
        body: 'feat: panel',
        link: '/system/svc-api',
        topic: 'ops',
      },
    });
    // Po wyniku śledzenie się kończy.
    expect(t.timers).toHaveLength(0);
  });

  it('nieudane wdrożenie → powiadomienie o błędzie', async () => {
    const t = setup([
      [api(deploy('d2', 'DEPLOYING'))],
      [api(deploy('d2', 'FAILED'))],
    ]);
    await t.tracker.run();
    // Pierwszy odczyt z czymś w toku też daje sygnał — panel ma to zobaczyć.
    expect(t.events).toEqual([{ topics: ['ops'] }]);
    await t.advance(FOLLOW_MS);
    expect(t.events[1]?.notice).toMatchObject({
      level: 'error',
      title: 'api — wdrożenie nieudane',
    });
  });

  it('wynik niewidziany w toku (np. po restarcie) — sygnał bez powiadomienia', async () => {
    const t = setup([
      [api(deploy('d1', 'SUCCESS'))],
      [api(deploy('d2', 'SUCCESS'))],
    ]);
    await t.tracker.run();
    await t.advance(MIN_GAP_MS);
    await t.tracker.run();
    expect(t.events).toEqual([{ topics: ['ops'] }]);
  });

  it('zmiana stanu czyści pamięć odczytu przez onChange', async () => {
    const t = setup([
      [api(deploy('d1', 'SUCCESS'))],
      [api(deploy('d2', 'QUEUED'))],
    ]);
    const cache = new IntegrationCache();
    const loads = jest.fn(() => Promise.resolve(1));
    await cache.get('railway', 60_000, loads);
    await cache.get('railway:svc-api:24h', 60_000, loads);
    t.tracker.onChange(() => {
      cache.invalidate('railway');
      cache.invalidatePrefix('railway:');
    });
    await t.tracker.run();
    await t.advance(MIN_GAP_MS);
    await t.tracker.run();
    await cache.get('railway', 60_000, loads);
    await cache.get('railway:svc-api:24h', 60_000, loads);
    expect(loads).toHaveBeenCalledTimes(4);
  });

  it('zawieszona budowa — koniec śledzenia po 30 min', async () => {
    const stuck = [api(deploy('d2', 'BUILDING'))];
    const t = setup(Array.from({ length: 400 }, () => stuck));
    await t.tracker.run();
    await t.advance(MAX_TRACK_MS + FOLLOW_MS * 2);
    const calls = t.load.mock.calls.length;
    await t.advance(FOLLOW_MS * 10);
    expect(t.load.mock.calls.length).toBe(calls);
    expect(calls).toBeLessThanOrEqual(MAX_TRACK_MS / FOLLOW_MS + 2);
  });

  it('błąd Railwaya nie rzuca i nie daje sygnału', async () => {
    const t = setup([new Error('Railway: 502')]);
    await expect(t.tracker.run()).resolves.toBeUndefined();
    expect(t.events).toEqual([]);
  });

  it('observe z przebiegu alertów bez pytania Railwaya', () => {
    const t = setup([]);
    t.tracker.observe([api(deploy('d1', 'SUCCESS'))]);
    t.tracker.observe([api(deploy('d2', 'BUILDING'))]);
    expect(t.load).not.toHaveBeenCalled();
    expect(t.events).toEqual([{ topics: ['ops'] }]);
    expect(t.timers).toHaveLength(1);
  });

  it('bez timerów (NODE_ENV=test) poke nic nie planuje', () => {
    const tracker = new DeployTrackerService();
    expect(tracker.timers).toBe(false);
    const load = jest.fn();
    tracker.io = { ...tracker.io, load };
    tracker.poke();
    expect(load).not.toHaveBeenCalled();
  });
});

describe('RailwayWebhookController', () => {
  const previous = process.env.RAILWAY_WEBHOOK_TOKEN;
  afterEach(() => {
    if (previous === undefined) delete process.env.RAILWAY_WEBHOOK_TOKEN;
    else process.env.RAILWAY_WEBHOOK_TOKEN = previous;
  });

  const controller = () => {
    const poke = jest.fn();
    const c = new RailwayWebhookController({
      poke,
    } as unknown as DeployTrackerService);
    return { c, poke };
  };

  it('dobry token → szturchnięcie', () => {
    process.env.RAILWAY_WEBHOOK_TOKEN = 's3kret-webhooka';
    const { c, poke } = controller();
    c.receive('s3kret-webhooka');
    expect(poke).toHaveBeenCalledTimes(1);
  });

  it('zły albo brakujący token → 404 bez szturchnięcia', () => {
    process.env.RAILWAY_WEBHOOK_TOKEN = 's3kret-webhooka';
    const { c, poke } = controller();
    expect(() => c.receive('zly')).toThrow(NotFoundException);
    expect(() => c.receive(undefined)).toThrow(NotFoundException);
    expect(() => c.receive(['s3kret-webhooka'])).toThrow(NotFoundException);
    expect(poke).not.toHaveBeenCalled();
  });

  it('bez RAILWAY_WEBHOOK_TOKEN trasy nie ma (404)', () => {
    delete process.env.RAILWAY_WEBHOOK_TOKEN;
    const { c, poke } = controller();
    expect(() => c.receive('')).toThrow(NotFoundException);
    expect(poke).not.toHaveBeenCalled();
  });

  it('sameSecret porównuje dokładnie', () => {
    expect(sameSecret('abc', 'abc')).toBe(true);
    expect(sameSecret('abc', 'abcd')).toBe(false);
  });

  it('token nie trafia do logu', () => {
    expect(redactUrl('/webhooks/railway?token=s3kret&x=1')).toBe(
      '/webhooks/railway?token=***&x=1',
    );
    expect(redactUrl('/admin/ops')).toBe('/admin/ops');
  });
});
