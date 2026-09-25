import {
  fetchRailwayLogs,
  fetchRailwayService,
  groupByStatusClass,
} from './railway-service.client';
import { toCronRun } from './railway.client';

type Body = { query: string; variables: Record<string, unknown> };

/** Railway GraphQL z tabeli: każde zapytanie rozpoznane po nazwie pola. */
function fakeRailway(answer: (b: Body) => unknown) {
  const bodies: Body[] = [];
  const impl = jest.fn((_url: string | URL, init: RequestInit = {}) => {
    const body = JSON.parse(init.body as string) as Body;
    bodies.push(body);
    return Promise.resolve(
      new Response(JSON.stringify(answer(body)), {
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return { impl: impl as unknown as typeof fetch, bodies };
}

const SCOPE = (b: Body) => {
  if (b.query.includes('projectToken'))
    return { data: { projectToken: { projectId: 'p', environmentId: 'e' } } };
  if (b.query.includes('environment(id'))
    return {
      data: {
        environment: {
          serviceInstances: {
            edges: [
              {
                node: {
                  serviceId: 'api',
                  serviceName: 'scoffie-backend',
                  cronSchedule: null,
                  nextCronRunAt: null,
                },
              },
              {
                node: {
                  serviceId: 'db',
                  serviceName: 'Postgres',
                  cronSchedule: null,
                  nextCronRunAt: null,
                },
              },
            ],
          },
        },
      },
    };
  return undefined;
};

const INSTANCE = {
  region: 'europe-west4',
  numReplicas: 1,
  restartPolicyType: 'ON_FAILURE',
  restartPolicyMaxRetries: 10,
  healthcheckPath: '/ops/health',
  startCommand: null,
  rootDirectory: null,
  builder: 'RAILPACK',
  sleepApplication: false,
  cronSchedule: null,
  nextCronRunAt: null,
  source: { repo: 'rpiechowicz/scoffie-backend', image: null },
};

describe('szczegóły usługi Railway', () => {
  it('konfiguracja, domeny, limity z ostatniej próbki, HTTP w klasach statusu', async () => {
    const { impl, bodies } = fakeRailway((b) => {
      const scope = SCOPE(b);
      if (scope) return scope;
      if (b.query.includes('serviceInstance('))
        return {
          data: {
            serviceInstance: INSTANCE,
            deployments: {
              edges: [
                {
                  node: {
                    id: 'd1',
                    status: 'SUCCESS',
                    createdAt: '2026-09-25T09:40:00Z',
                    statusUpdatedAt: '2026-09-25T09:42:10Z',
                    meta: {
                      commitHash: 'abc',
                      commitMessage: 'fix',
                      branch: 'main',
                    },
                  },
                },
              ],
            },
            domains: {
              serviceDomains: [{ domain: 'x.up.railway.app' }],
              customDomains: [{ domain: 'api.scoffie.app' }],
            },
          },
        };
      if (b.query.includes('metrics('))
        return {
          data: {
            metrics: [
              {
                measurement: 'CPU_USAGE',
                values: [
                  { ts: 1, value: 0.1 },
                  { ts: 2, value: 0.3 },
                ],
              },
              {
                measurement: 'CPU_LIMIT',
                values: [
                  { ts: 1, value: 8 },
                  { ts: 2, value: 4 },
                ],
              },
            ],
          },
        };
      if (b.query.includes('httpMetricsGroupedByStatus'))
        return {
          data: {
            httpMetricsGroupedByStatus: [
              { statusCode: 200, samples: [{ ts: 1, value: 10 }] },
              { statusCode: 204, samples: [{ ts: 1, value: 2 }] },
              { statusCode: 503, samples: [{ ts: 1, value: 1 }] },
            ],
            httpDurationMetrics: {
              samples: [{ ts: 1, p50: 12, p95: 80, p99: 200 }],
            },
          },
        };
      throw new Error(`nieoczekiwane zapytanie ${b.query}`);
    });

    const now = new Date('2026-09-25T10:00:00Z');
    const d = await fetchRailwayService('tok', 'api', '6h', impl, now);

    expect(d).toMatchObject({
      name: 'scoffie-backend',
      range: '6h',
      url: 'https://railway.com/project/p/service/api?environmentId=e',
      config: {
        region: 'europe-west4',
        healthcheckPath: '/ops/health',
        repo: 'rpiechowicz/scoffie-backend',
        sleeps: false,
        domains: ['api.scoffie.app', 'x.up.railway.app'],
      },
      metrics: { cpuLimit: 4, memoryLimitGb: null, diskGb: [] },
      http: {
        requests: [
          { ts: 1, ok: 12, redirect: 0, clientError: 0, serverError: 1 },
        ],
        latency: [{ ts: 1, p50: 12, p95: 80, p99: 200 }],
      },
      deploys: [
        {
          id: 'd1',
          commitHash: 'abc',
          statusUpdatedAt: '2026-09-25T09:42:10Z',
        },
      ],
    });
    const metrics = bodies.find((b) => b.query.includes('metrics('))!;
    expect(metrics.variables).toMatchObject({
      sid: 'api',
      step: 300,
      start: '2026-09-25T04:00:00.000Z',
      end: '2026-09-25T10:00:00.000Z',
    });
  });

  it('usługa bez domeny: bez pytania o HTTP; awaria metryk nie gasi strony', async () => {
    const { impl, bodies } = fakeRailway((b) => {
      const scope = SCOPE(b);
      if (scope) return scope;
      if (b.query.includes('serviceInstance('))
        return {
          data: {
            serviceInstance: {
              ...INSTANCE,
              source: { repo: null, image: 'postgres:17' },
            },
            deployments: { edges: [] },
            domains: { serviceDomains: [], customDomains: [] },
          },
        };
      if (b.query.includes('metrics('))
        return { errors: [{ message: 'boom' }] };
      throw new Error('HTTP nie powinno być pytane');
    });
    const d = await fetchRailwayService('tok', 'db', '24h', impl);
    expect(d).toMatchObject({
      http: null,
      config: { image: 'postgres:17' },
      metrics: { cpu: [] },
    });
    expect(bodies.some((b) => b.query.includes('httpMetrics'))).toBe(false);
  });

  it('cron: do 30 uruchomień, najnowsze pierwsze; bez crona — bez pytania', async () => {
    const withCron = (b: Body) => {
      const scope = SCOPE(b) as
        | {
            data: {
              environment?: {
                serviceInstances: {
                  edges: { node: Record<string, unknown> }[];
                };
              };
            };
          }
        | undefined;
      const edges = scope?.data.environment?.serviceInstances.edges;
      if (edges) edges[1].node.cronSchedule = '15 3 * * *';
      return scope;
    };
    const { impl, bodies } = fakeRailway((b) => {
      const scope = withCron(b);
      if (scope) return scope;
      if (b.query.includes('serviceInstance('))
        return {
          data: {
            serviceInstance: INSTANCE,
            deployments: { edges: [] },
            domains: { serviceDomains: [], customDomains: [] },
          },
        };
      if (b.query.includes('deploymentInstanceExecutions('))
        return {
          data: {
            deploymentInstanceExecutions: {
              edges: Array.from({ length: 35 }, (_, i) => ({
                node: {
                  id: `r${i}`,
                  status: i === 0 ? 'RUNNING' : 'EXITED',
                  createdAt: new Date(
                    Date.UTC(2026, 7, 1 + i, 3, 15),
                  ).toISOString(),
                  updatedAt: new Date(
                    Date.UTC(2026, 7, 1 + i, 3, 17),
                  ).toISOString(),
                  completedAt: null,
                },
              })),
            },
          },
        };
      return { data: { metrics: [] } };
    });
    const d = await fetchRailwayService('tok', 'db', '24h', impl);
    expect(d.runs).toHaveLength(30);
    expect(d.runs[0]).toMatchObject({ id: 'r34', status: 'EXITED' });
    expect(d.runs[0].finishedAt).toBe('2026-09-04T03:17:00.000Z');

    const plain = await fetchRailwayService('tok', 'api', '24h', impl);
    expect(plain.runs).toEqual([]);
    expect(
      bodies.filter((b) => b.query.includes('deploymentInstanceExecutions('))
        .length,
    ).toBe(1);
  });

  it('uruchomienie w toku nie ma końca', () => {
    expect(
      toCronRun({
        id: 'r',
        status: 'RUNNING',
        createdAt: '2026-09-25T03:15:00Z',
        updatedAt: '2026-09-25T03:15:10Z',
      }).finishedAt,
    ).toBeNull();
  });

  it('obcy id usługi → błąd, zanim padnie pytanie o jej dane', async () => {
    const { impl, bodies } = fakeRailway((b) => SCOPE(b) ?? { data: {} });
    await expect(
      fetchRailwayService('tok', 'obca', '24h', impl),
    ).rejects.toThrow(/nie ma takiej usługi/);
    expect(bodies.some((b) => b.query.includes('serviceInstance('))).toBe(
      false,
    );
  });
});

describe('logi usługi Railway', () => {
  it('wdrożenie cudzej usługi → odmowa, nie cudze logi', async () => {
    const { impl, bodies } = fakeRailway((b) => {
      const scope = SCOPE(b);
      if (scope) return scope;
      if (b.query.includes('deployment(id'))
        return {
          data: {
            deployment: { id: 'd9', serviceId: 'db', environmentId: 'e' },
          },
        };
      throw new Error('logi nie powinny być pytane');
    });
    await expect(
      fetchRailwayLogs(
        'tok',
        'api',
        { deploymentId: 'd9', kind: 'deploy' },
        impl,
      ),
    ).rejects.toThrow(/nie należy do tej usługi/);
    expect(bodies.some((b) => b.query.includes('Logs('))).toBe(false);
  });

  it('bez wdrożenia — ostatnie; budowanie z filtrem; rosnąco po czasie', async () => {
    const { impl, bodies } = fakeRailway((b) => {
      const scope = SCOPE(b);
      if (scope) return scope;
      if (b.query.includes('deployments(first: 1'))
        return { data: { deployments: { edges: [{ node: { id: 'd1' } }] } } };
      if (b.query.includes('buildLogs('))
        return {
          data: {
            logs: [
              {
                timestamp: '2026-09-25T10:00:02Z',
                severity: 'ERROR',
                message: 'b',
              },
              {
                timestamp: '2026-09-25T10:00:01Z',
                severity: null,
                message: 'a',
              },
            ],
          },
        };
      throw new Error(`nieoczekiwane ${b.query}`);
    });
    const logs = await fetchRailwayLogs(
      'tok',
      'api',
      { kind: 'build', filter: ' @level:error ' },
      impl,
    );
    expect(logs).toEqual({
      deploymentId: 'd1',
      kind: 'build',
      lines: [
        { timestamp: '2026-09-25T10:00:01Z', severity: null, message: 'a' },
        { timestamp: '2026-09-25T10:00:02Z', severity: 'error', message: 'b' },
      ],
    });
    expect(
      bodies.find((b) => b.query.includes('buildLogs('))!.variables,
    ).toMatchObject({ id: 'd1', filter: '@level:error', limit: 500 });
  });
});

describe('groupByStatusClass', () => {
  it('sumuje kody w klasy i łączy po czasie', () => {
    expect(
      groupByStatusClass([
        { statusCode: 301, samples: [{ ts: 2, value: 1 }] },
        {
          statusCode: 404,
          samples: [
            { ts: 1, value: 3 },
            { ts: 2, value: 1 },
          ],
        },
        { statusCode: 200, samples: [{ ts: 2, value: 5 }] },
      ]),
    ).toEqual([
      { ts: 1, ok: 0, redirect: 0, clientError: 3, serverError: 0 },
      { ts: 2, ok: 5, redirect: 1, clientError: 1, serverError: 0 },
    ]);
  });
});
