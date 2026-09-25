import { generateKeyPairSync } from 'node:crypto';
import { jwtVerify } from 'jose';
import { fetchAppStore } from './app-store-connect.client';
import {
  IntegrationCache,
  IntegrationError,
  normalizePrivateKey,
} from './integration-fetch';
import { missingAsc, readAscEnv, readSentryEnv } from './integrations-env';
import { fetchRailway } from './railway.client';
import { fetchResendDomains } from './resend-domains.client';
import { fetchSentry } from './sentry.client';

type Route = (url: URL, init: RequestInit) => Response | undefined;

/** `fetch` z tabeli tras — nieznany adres to błąd testu, nie cicha pustka. */
function fakeFetch(...routes: Route[]) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const impl = jest.fn((input: string | URL, init: RequestInit = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    for (const route of routes) {
      const res = route(url, init);
      if (res) return Promise.resolve(res);
    }
    return Promise.reject(new Error(`nieoczekiwany adres ${url.href}`));
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('IntegrationCache', () => {
  it('jedno wywołanie na okno, błąd dostawcy jako stan, nie wyjątek', async () => {
    let now = 0;
    const cache = new IntegrationCache(() => now);
    const load = jest
      .fn()
      .mockRejectedValueOnce(new IntegrationError('Sentry: HTTP 500'));

    const [a, b] = await Promise.all([
      cache.get('k', 1000, load),
      cache.get('k', 1000, load),
    ]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(a).toMatchObject({ status: 'error', message: 'Sentry: HTTP 500' });
    expect(b).toBe(a);

    load.mockResolvedValueOnce({ ok: 1 });
    now = 1001;
    expect(await cache.get('k', 1000, load)).toMatchObject({
      status: 'ok',
      data: { ok: 1 },
    });
  });

  it('nieznany wyjątek nie wycieka treścią do panelu', async () => {
    const state = await new IntegrationCache().get('k', 1, () =>
      Promise.reject(new Error('token=sekret')),
    );
    expect(state).toMatchObject({ status: 'error' });
    expect(JSON.stringify(state)).not.toContain('sekret');
  });
});

describe('Sentry', () => {
  const env = { ...readSentryEnv({}), token: 't0k' };

  it('crash-free w procentach, projekt bez sesji → null, zdarzenia z okna 24 h', async () => {
    const { impl, calls } = fakeFetch(
      (u) =>
        u.pathname.endsWith('/projects/')
          ? json([
              { id: '1', slug: 'scoffie-ios' },
              { id: '2', slug: 'scoffie-backend' },
              { id: '9', slug: 'obcy' },
            ])
          : undefined,
      (u) =>
        u.pathname.endsWith('/issues-count/')
          ? json({
              'is:unresolved': u.searchParams.get('project') === '1' ? 4 : 1,
              'is:unresolved firstSeen:-24h': 1,
            })
          : undefined,
      (u) =>
        u.pathname.endsWith('/sessions/')
          ? u.searchParams.get('project') === '1'
            ? json({
                groups: [
                  {
                    totals: {
                      'crash_free_rate(session)': 0.99812,
                      'crash_free_rate(user)': 0.995,
                    },
                  },
                ],
              })
            : json({ detail: 'no sessions' }, 400)
          : undefined,
      (u) =>
        u.pathname.endsWith('/stats_v2/')
          ? json({
              groups: [{ by: { project: 1 }, totals: { 'sum(quantity)': 42 } }],
            })
          : undefined,
      (u) =>
        u.pathname.endsWith('/releases/')
          ? u.searchParams.get('project') === '1'
            ? json([
                {
                  version: 'app.scoffie.ios@1.0+35',
                  dateCreated: '2026-09-24T17:00:00Z',
                },
              ])
            : json({ detail: 'boom' }, 500)
          : undefined,
      (u) =>
        u.pathname.endsWith('/issues/')
          ? json([
              {
                id: '77',
                shortId: 'SCOFFIE-IOS-1A',
                title: 'EXC_BAD_ACCESS',
                culprit: '',
                count: '900',
                userCount: 3,
                firstSeen: '2026-09-20T00:00:00Z',
                lastSeen: '2026-09-25T00:00:00Z',
                permalink: 'https://scoffie.sentry.io/issues/77/',
                project: { slug: 'scoffie-ios' },
                stats: {
                  '24h': [
                    [1, 2],
                    [2, 5],
                  ],
                },
              },
            ])
          : undefined,
    );

    const data = await fetchSentry(
      { ...env, projects: ['scoffie-ios', 'scoffie-backend', 'nie-ma'] },
      impl,
    );

    expect(data.projects).toEqual([
      {
        slug: 'scoffie-ios',
        crashFreeUsers: 99.5,
        crashFreeSessions: 99.81,
        unresolved: 4,
        new24h: 1,
        events24h: 42,
        release: {
          version: 'app.scoffie.ios@1.0+35',
          createdAt: '2026-09-24T17:00:00Z',
        },
      },
      {
        slug: 'scoffie-backend',
        crashFreeUsers: null,
        crashFreeSessions: null,
        unresolved: 1,
        new24h: 1,
        // Brak w statystykach = 0 zdarzeń; awaria wydań = brak wydania, nie błąd karty.
        events24h: 0,
        release: null,
      },
    ]);
    expect(data.missing).toEqual(['nie-ma']);
    expect(data.issues[0]).toMatchObject({
      shortId: 'SCOFFIE-IOS-1A',
      count: 7,
      culprit: null,
      level: 'error',
    });
    expect(calls[0].url.origin).toBe('https://de.sentry.io');
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe(
      'Bearer t0k',
    );
    const issues = calls.find((c) => c.url.pathname.endsWith('/issues/'))!.url;
    expect(issues.searchParams.getAll('project')).toEqual(['1', '2']);
  });

  it('401 → czytelny błąd z podpowiedzią o uprawnieniach', async () => {
    const { impl } = fakeFetch(() => json({ detail: 'Invalid token' }, 401));
    await expect(fetchSentry(env, impl)).rejects.toThrow(
      /HTTP 401 — klucz odrzucony/,
    );
  });
});

describe('Railway', () => {
  it('projekt i środowisko z tokenu, deploye z commitem, metryki per usługa', async () => {
    const { impl, calls } = fakeFetch((_u, init) => {
      const { query, variables } = JSON.parse(init.body as string) as {
        query: string;
        variables: Record<string, string>;
      };
      if (query.includes('projectToken'))
        return json({
          data: { projectToken: { projectId: 'p1', environmentId: 'e1' } },
        });
      if (query.includes('environment(id'))
        return json({
          data: {
            environment: {
              serviceInstances: {
                edges: [
                  {
                    node: {
                      serviceId: 's2',
                      serviceName: 'scoffie-backend',
                      cronSchedule: null,
                      nextCronRunAt: null,
                    },
                  },
                  {
                    node: {
                      serviceId: 's1',
                      serviceName: 'db-backup',
                      cronSchedule: '0 3 * * *',
                      nextCronRunAt: '2026-09-26T03:00:00Z',
                    },
                  },
                ],
              },
            },
          },
        });
      if (query.includes('metrics('))
        return json({
          data: {
            metrics: [
              {
                measurement: 'CPU_USAGE',
                tags: { serviceId: 's2' },
                values: [{ ts: 1, value: 0.2 }],
              },
            ],
          },
        });
      if (query.includes('deployments(')) {
        return json({
          data: {
            deployments: {
              edges: [
                {
                  node: {
                    id: `d-${variables.sid}`,
                    status: variables.sid === 's1' ? 'FAILED' : 'SUCCESS',
                    createdAt: '2026-09-25T08:00:00Z',
                    meta: {
                      commitHash: 'abc1234def',
                      commitMessage: 'fix',
                      branch: 'main',
                    },
                  },
                },
              ],
            },
          },
        });
      }
      return undefined;
    });

    const data = await fetchRailway(
      'tok',
      impl,
      new Date('2026-09-25T10:00:00Z'),
    );

    expect(data.services.map((s) => s.name)).toEqual([
      'db-backup',
      'scoffie-backend',
    ]);
    const [backup, backend] = data.services;
    expect(backup).toMatchObject({
      cron: '0 3 * * *',
      deploys: [{ status: 'FAILED', commitHash: 'abc1234def', branch: 'main' }],
      cpu: [],
    });
    expect(backend.cpu).toEqual([{ ts: 1, value: 0.2 }]);
    expect(backend.url).toBe(
      'https://railway.com/project/p1/service/s2?environmentId=e1',
    );
    expect(new Headers(calls[0].init.headers).get('project-access-token')).toBe(
      'tok',
    );
    // Pytanie o instancję usługi spoza środowiska kończy się błędem całego
    // zapytania („ServiceInstance not found”) — listę daje samo środowisko.
    expect(
      calls.some((c) => (c.init.body as string).includes('serviceInstance(')),
    ).toBe(false);
  });

  it('błąd GraphQL w odpowiedzi 200 → błąd integracji', async () => {
    const { impl } = fakeFetch(() =>
      json({ errors: [{ message: 'Not Authorized' }] }),
    );
    await expect(fetchRailway('zły', impl)).rejects.toThrow(
      'Railway: Not Authorized',
    );
  });

  it('awaria metryk nie zasłania deployów', async () => {
    const { impl } = fakeFetch((_u, init) => {
      const { query } = JSON.parse(init.body as string) as { query: string };
      if (query.includes('projectToken'))
        return json({
          data: { projectToken: { projectId: 'p', environmentId: 'e' } },
        });
      if (query.includes('environment(id'))
        return json({
          data: {
            environment: {
              serviceInstances: {
                edges: [
                  {
                    node: {
                      serviceId: 's',
                      serviceName: 'x',
                      cronSchedule: null,
                      nextCronRunAt: null,
                    },
                  },
                ],
              },
            },
          },
        });
      if (query.includes('metrics('))
        return json({ errors: [{ message: 'boom' }] });
      return json({
        data: { deployments: { edges: [] } },
      });
    });
    expect((await fetchRailway('t', impl)).services[0]).toMatchObject({
      name: 'x',
      cpu: [],
      deploys: [],
    });
  });
});

describe('App Store Connect', () => {
  const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = keys.privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const env = {
    keyId: 'KEY123',
    issuerId: 'iss-1',
    privateKey: pem,
    bundleId: 'app.scoffie.ios',
  };

  it('token ES256 bez `bid`, build z wersją z preReleaseVersion, recenzja z odpowiedzią', async () => {
    const { impl, calls } = fakeFetch(
      (u) =>
        u.pathname === '/v1/apps'
          ? json({
              data: [
                {
                  id: 'A1',
                  type: 'apps',
                  attributes: { name: 'Scoffie', bundleId: 'app.scoffie.ios' },
                },
              ],
            })
          : undefined,
      (u) =>
        u.pathname === '/v1/builds'
          ? json({
              data: [
                {
                  id: 'b1',
                  type: 'builds',
                  attributes: {
                    version: '35',
                    uploadedDate: '2026-09-24T10:00:00Z',
                    processingState: 'VALID',
                    expired: false,
                  },
                  relationships: {
                    preReleaseVersion: {
                      data: { type: 'preReleaseVersions', id: 'p1' },
                    },
                  },
                },
              ],
              included: [
                {
                  id: 'p1',
                  type: 'preReleaseVersions',
                  attributes: { version: '1.0' },
                },
              ],
            })
          : undefined,
      (u) =>
        u.pathname === '/v1/apps/A1/appStoreVersions'
          ? json({
              data: [
                {
                  id: 'v0',
                  type: 'appStoreVersions',
                  attributes: {
                    versionString: '0.9',
                    appStoreState: 'REJECTED',
                    createdDate: '2026-09-01T00:00:00Z',
                  },
                },
                {
                  id: 'v1',
                  type: 'appStoreVersions',
                  attributes: {
                    versionString: '1.0',
                    appVersionState: 'WAITING_FOR_REVIEW',
                    createdDate: '2026-09-20T00:00:00Z',
                  },
                },
              ],
            })
          : undefined,
      (u) =>
        u.pathname === '/v1/apps/A1/customerReviews'
          ? json({
              data: [
                {
                  id: 'r1',
                  type: 'customerReviews',
                  attributes: {
                    rating: 5,
                    title: 'Super',
                    body: '',
                    reviewerNickname: 'Ala',
                    territory: 'POL',
                    createdDate: '2026-09-25T00:00:00Z',
                  },
                  relationships: {
                    response: {
                      data: { type: 'customerReviewResponses', id: 'x1' },
                    },
                  },
                },
              ],
              included: [
                {
                  id: 'x1',
                  type: 'customerReviewResponses',
                  attributes: { responseBody: 'Dzięki!', state: 'PUBLISHED' },
                },
              ],
            })
          : undefined,
    );

    const data = await fetchAppStore(env, impl);

    expect(data.builds).toEqual([
      {
        id: 'b1',
        build: '35',
        version: '1.0',
        processingState: 'VALID',
        uploadedAt: '2026-09-24T10:00:00Z',
        expired: false,
      },
    ]);
    expect(data.versions.map((v) => [v.version, v.state])).toEqual([
      ['1.0', 'WAITING_FOR_REVIEW'],
      ['0.9', 'REJECTED'],
    ]);
    expect(data.reviews[0]).toMatchObject({
      rating: 5,
      body: null,
      response: { body: 'Dzięki!', state: 'PUBLISHED' },
    });
    expect(data.url).toBe(
      'https://appstoreconnect.apple.com/apps/A1/distribution',
    );

    const token = new Headers(calls[0].init.headers)
      .get('authorization')!
      .slice('Bearer '.length);
    const { payload: claims, protectedHeader } = await jwtVerify(
      token,
      keys.publicKey,
    );
    expect(protectedHeader).toMatchObject({ alg: 'ES256', kid: 'KEY123' });
    expect(claims).toMatchObject({ iss: 'iss-1', aud: 'appstoreconnect-v1' });
    expect(claims).not.toHaveProperty('bid');
    expect(claims.exp! - claims.iat!).toBe(300);
    // Tylko GET — panel nic w App Store Connect nie zmienia.
    expect(calls.every((c) => (c.init.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('zepsuty klucz → błąd konfiguracji, zanim cokolwiek pójdzie do Apple', async () => {
    const { impl, calls } = fakeFetch(() => json({}));
    await expect(
      fetchAppStore({ ...env, privateKey: 'nie-klucz' }, impl),
    ).rejects.toThrow(/ADMIN_ASC_PRIVATE_KEY/);
    expect(calls).toHaveLength(0);
  });

  it('brakujące zmienne po nazwie; Issuer ID domyślnie z APPLE_ISSUER_ID', () => {
    expect(missingAsc(readAscEnv({}))).toEqual([
      'ADMIN_ASC_KEY_ID',
      'ADMIN_ASC_PRIVATE_KEY',
      'APPLE_ISSUER_ID',
    ]);
    expect(readAscEnv({ APPLE_ISSUER_ID: 'x' }).issuerId).toBe('x');
    expect(normalizePrivateKey('QUJD\\nREVG')).toBe(
      '-----BEGIN PRIVATE KEY-----\nQUJDREVG\n-----END PRIVATE KEY-----',
    );
  });
});

describe('Resend', () => {
  it('klucz tylko do wysyłki → komunikat, że poczta działa', async () => {
    const { impl } = fakeFetch(() =>
      json(
        {
          name: 'restricted_api_key',
          message: 'This API key is restricted to only send emails',
        },
        401,
      ),
    );
    await expect(fetchResendDomains('re_x', impl)).rejects.toThrow(
      /tylko do wysyłki/,
    );
  });

  it('domeny ze statusem', async () => {
    const { impl } = fakeFetch(() =>
      json({
        data: [
          { name: 'scoffie.app', status: 'verified', region: 'eu-west-1' },
        ],
      }),
    );
    expect(await fetchResendDomains('re_x', impl)).toEqual({
      domains: [
        { name: 'scoffie.app', status: 'verified', region: 'eu-west-1' },
      ],
    });
  });
});
