import { HttpException } from '@nestjs/common';
import type { ApnsService } from '../../notifications/apns.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { AdminRateLimiter } from '../admin-rate-limiter';
import type {
  AdminActor,
  AdminAuditEntry,
  AdminAuditService,
} from '../audit/admin-audit.service';
import { fetchSentryUser } from '../integrations/sentry.client';
import type { SentryEnv } from '../integrations/integrations-env';
import {
  AdminPushTestService,
  PUSH_TEST_PAYLOAD,
  PUSH_TEST_PER_MINUTE,
} from './admin-push-test.service';
import { isOwnerAccount } from './owner-account';

const USER = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';

const actor: AdminActor = {
  adminUserId: 'admin-1',
  adminEmail: 'owner@scoffie.app',
  sessionId: 's',
  ip: null,
  country: null,
  requestId: null,
};

function setup(options: {
  email: string | null;
  device?: boolean;
  configured?: boolean;
}) {
  const entries: AdminAuditEntry[] = [];
  const audit = {
    run: jest.fn(
      async <T>(
        _a: AdminActor,
        entry: AdminAuditEntry,
        fn: () => Promise<T>,
      ) => {
        entries.push(entry);
        return fn();
      },
    ),
  } as unknown as AdminAuditService;
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ email: options.email }),
    },
    pushDevice: {
      findFirst: jest.fn().mockResolvedValue(
        options.device === false
          ? null
          : {
              deviceToken: 'token',
              appBundleId: 'app.scoffie',
              apnsEnvironment: 'SANDBOX',
            },
      ),
    },
  } as unknown as PrismaService;
  const sendWithResult = jest.fn().mockResolvedValue({
    status: 200,
    apnsId: 'APNS-1',
    reason: null,
    environment: 'SANDBOX',
    topic: 'app.scoffie',
  });
  const apns = {
    isConfigured: () => options.configured ?? true,
    defaultEnvironment: 'PRODUCTION',
    sendWithResult,
  } as unknown as ApnsService;
  const service = new AdminPushTestService(
    prisma,
    audit,
    apns,
    new AdminRateLimiter(),
  );
  return { service, entries, sendWithResult };
}

const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return (error as HttpException).getStatus();
  }
  return 200;
};

describe('isOwnerAccount', () => {
  it('adres z ADMIN_BOOTSTRAP_EMAIL (wielkość liter bez znaczenia)', () => {
    const env = { ADMIN_BOOTSTRAP_EMAIL: 'Owner@Scoffie.app, drugi@x.pl' };
    expect(isOwnerAccount(' OWNER@scoffie.app ', env)).toBe(true);
    expect(isOwnerAccount('drugi@x.pl', env)).toBe(true);
    expect(isOwnerAccount('obcy@x.pl', env)).toBe(false);
    expect(isOwnerAccount(null, env)).toBe(false);
    expect(isOwnerAccount('', {})).toBe(false);
  });
});

describe('AdminPushTestService', () => {
  const saved = process.env.ADMIN_BOOTSTRAP_EMAIL;
  beforeEach(() => {
    process.env.ADMIN_BOOTSTRAP_EMAIL = 'owner@scoffie.app';
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.ADMIN_BOOTSTRAP_EMAIL;
    else process.env.ADMIN_BOOTSTRAP_EMAIL = saved;
  });

  it('urządzenie właściciela: jeden push neutralną treścią, wynik APNs i audyt', async () => {
    const { service, entries, sendWithResult } = setup({
      email: 'owner@scoffie.app',
    });
    const result = await service.send(actor, USER, DEVICE, {});
    expect(result).toMatchObject({
      ok: true,
      status: 200,
      apnsId: 'APNS-1',
      environment: 'SANDBOX',
    });
    expect(sendWithResult).toHaveBeenCalledTimes(1);
    expect(sendWithResult).toHaveBeenCalledWith(
      'token',
      PUSH_TEST_PAYLOAD,
      'app.scoffie',
      'SANDBOX',
    );
    expect(PUSH_TEST_PAYLOAD.body).toBe('Test z panelu Scoffie');
    expect(PUSH_TEST_PAYLOAD.data).toBeUndefined();
    expect(entries).toEqual([
      expect.objectContaining({
        action: 'user.push.test',
        targetType: 'PushDevice',
        targetId: DEVICE,
        reason: null,
        details: { userId: USER, foreign: false, environment: 'SANDBOX' },
      }),
    ]);
  });

  it('obca osoba: bez potwierdzenia i powodu 403 i NIC nie wychodzi', async () => {
    const { service, sendWithResult, entries } = setup({ email: 'ktos@x.pl' });
    expect(await status(service.send(actor, USER, DEVICE, {}))).toBe(403);
    expect(
      await status(service.send(actor, USER, DEVICE, { confirmForeign: true })),
    ).toBe(403);
    expect(
      await status(
        service.send(actor, USER, DEVICE, { reason: 'zgłoszenie #12' }),
      ),
    ).toBe(403);
    expect(sendWithResult).not.toHaveBeenCalled();
    expect(entries).toHaveLength(0);
  });

  it('obca osoba z potwierdzeniem i powodem: wysyła, powód w dzienniku', async () => {
    const { service, sendWithResult, entries } = setup({ email: 'ktos@x.pl' });
    await service.send(actor, USER, DEVICE, {
      confirmForeign: true,
      reason: 'zgłoszenie #12 — brak pushy',
    });
    expect(sendWithResult).toHaveBeenCalledTimes(1);
    expect(entries[0]).toMatchObject({
      reason: 'zgłoszenie #12 — brak pushy',
      details: { foreign: true },
    });
  });

  it('cudze urządzenie (inny userId) → 404; APNs wyłączony → 503', async () => {
    expect(
      await status(
        setup({ email: 'owner@scoffie.app', device: false }).service.send(
          actor,
          USER,
          DEVICE,
          {},
        ),
      ),
    ).toBe(404);
    const off = setup({ email: 'owner@scoffie.app', configured: false });
    expect(await status(off.service.send(actor, USER, DEVICE, {}))).toBe(503);
    expect(off.sendWithResult).not.toHaveBeenCalled();
  });

  it(`limit ${PUSH_TEST_PER_MINUTE} na minutę na admina → 429`, async () => {
    const { service, sendWithResult } = setup({ email: 'owner@scoffie.app' });
    for (let i = 0; i < PUSH_TEST_PER_MINUTE; i += 1) {
      await service.send(actor, USER, DEVICE, {});
    }
    expect(await status(service.send(actor, USER, DEVICE, {}))).toBe(429);
    expect(sendWithResult).toHaveBeenCalledTimes(PUSH_TEST_PER_MINUTE);
  });
});

describe('fetchSentryUser', () => {
  const env: SentryEnv = {
    token: 't',
    org: 'scoffie',
    apiUrl: 'https://de.sentry.io',
    projects: ['scoffie-ios', 'scoffie-backend'],
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  function fake(events: () => Response) {
    const urls: URL[] = [];
    const impl = jest.fn((input: string | URL) => {
      const url = new URL(input);
      urls.push(url);
      if (url.pathname.endsWith('/projects/')) {
        return Promise.resolve(
          json([
            { id: '1', slug: 'scoffie-ios' },
            { id: '2', slug: 'scoffie-backend' },
          ]),
        );
      }
      if (url.pathname.endsWith('/issues/')) {
        return Promise.resolve(
          json([
            {
              id: '9',
              shortId: 'SCOFFIE-IOS-9',
              title: 'Crash',
              level: 'fatal',
              count: '100',
              userCount: 3,
              firstSeen: '2026-09-20T00:00:00Z',
              lastSeen: '2026-09-24T00:00:00Z',
              permalink: 'https://scoffie.sentry.io/issues/9/',
              project: { slug: 'scoffie-ios' },
              stats: {
                '14d': [
                  [1, 2],
                  [2, 5],
                ],
              },
            },
          ]),
        );
      }
      if (url.pathname.endsWith('/events/')) return Promise.resolve(events());
      return Promise.reject(new Error(`nieoczekiwany ${url.href}`));
    });
    return { impl: impl as unknown as typeof fetch, urls };
  }

  it('problemy i zdarzenia po user.id z 14 dni, tylko projekty z konfiguracji', async () => {
    const { impl, urls } = fake(() =>
      json({
        data: [
          {
            id: 'ev1',
            title: 'Crash',
            level: 'fatal',
            project: 'scoffie-ios',
            release: 'app.scoffie@1.0.3+35',
            timestamp: '2026-09-24T10:00:00+00:00',
            'issue.id': 9,
          },
          { title: 'bez id' },
        ],
      }),
    );
    const data = await fetchSentryUser(env, USER, impl);

    const issues = urls.find((u) => u.pathname.endsWith('/issues/'))!;
    expect(issues.searchParams.get('query')).toBe(`user.id:${USER}`);
    expect(issues.searchParams.get('statsPeriod')).toBe('14d');
    expect(issues.searchParams.getAll('project')).toEqual(['1', '2']);
    const events = urls.find((u) => u.pathname.endsWith('/events/'))!;
    expect(events.searchParams.get('query')).toBe(`user.id:${USER}`);
    expect(events.searchParams.getAll('field')).toEqual(
      expect.arrayContaining(['id', 'title', 'release', 'timestamp']),
    );

    expect(data.issues).toEqual([
      expect.objectContaining({ shortId: 'SCOFFIE-IOS-9', count: 7 }),
    ]);
    expect(data.events).toEqual([
      {
        id: 'ev1',
        title: 'Crash',
        level: 'fatal',
        project: 'scoffie-ios',
        release: 'app.scoffie@1.0.3+35',
        at: '2026-09-24T10:00:00+00:00',
        permalink: 'https://scoffie.sentry.io/issues/9/events/ev1/',
      },
    ]);
    expect(data.eventsUnavailable).toBe(false);
    expect(data.url).toContain(encodeURIComponent(`user.id:${USER}`));
  });

  it('porażka zdarzeń (Discover) nie kładzie karty — `eventsUnavailable`', async () => {
    const { impl } = fake(() => json({ detail: 'Invalid field' }, 400));
    const data = await fetchSentryUser(env, USER, impl);
    expect(data.issues).toHaveLength(1);
    expect(data.events).toEqual([]);
    expect(data.eventsUnavailable).toBe(true);
  });
});
