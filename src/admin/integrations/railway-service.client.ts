import type {
  LatencyPoint,
  MetricPoint,
  OpsRange,
  RailwayDeployDetail,
  RailwayLogs,
  RailwayServiceDetail,
} from '../contract';
import { IntegrationError } from './integration-fetch';
import {
  railwayGql,
  railwayScope,
  railwayServiceUrl,
  toDeploy,
  type ApiDeploy,
  type RailwayGql,
  type RailwayScope,
} from './railway.client';

const DEPLOYS = 20;
const LOG_LINES = 500;

/** Okres wykresu → długość i krok próbek (ok. 60–180 punktów na wykres). */
export const OPS_RANGES: Record<OpsRange, { ms: number; step: number }> = {
  '1h': { ms: 3_600_000, step: 60 },
  '6h': { ms: 6 * 3_600_000, step: 300 },
  '24h': { ms: 24 * 3_600_000, step: 900 },
  '7d': { ms: 7 * 86_400_000, step: 3_600 },
  '30d': { ms: 30 * 86_400_000, step: 14_400 },
};

const SERVICE_QUERY = `query ($pid: String!, $eid: String!, $sid: String!) {
  serviceInstance(serviceId: $sid, environmentId: $eid) {
    region numReplicas restartPolicyType restartPolicyMaxRetries healthcheckPath
    startCommand rootDirectory builder sleepApplication cronSchedule nextCronRunAt
    source { repo image }
  }
  deployments(first: ${DEPLOYS}, input: { projectId: $pid, environmentId: $eid, serviceId: $sid }) {
    edges { node { id status createdAt statusUpdatedAt meta } }
  }
  domains(projectId: $pid, environmentId: $eid, serviceId: $sid) {
    serviceDomains { domain }
    customDomains { domain }
  }
}`;

const METRICS_QUERY = `query ($eid: String!, $sid: String!, $start: DateTime!, $end: DateTime!, $step: Int!) {
  metrics(environmentId: $eid, serviceId: $sid, startDate: $start, endDate: $end,
    sampleRateSeconds: $step,
    measurements: [CPU_USAGE, CPU_LIMIT, MEMORY_USAGE_GB, MEMORY_LIMIT_GB, NETWORK_RX_GB, NETWORK_TX_GB, DISK_USAGE_GB]) {
    measurement values { ts value }
  }
}`;

const HTTP_QUERY = `query ($eid: String!, $sid: String!, $start: DateTime!, $end: DateTime!, $step: Int!) {
  httpMetricsGroupedByStatus(environmentId: $eid, serviceId: $sid, startDate: $start, endDate: $end, stepSeconds: $step) {
    statusCode samples { ts value }
  }
  httpDurationMetrics(environmentId: $eid, serviceId: $sid, startDate: $start, endDate: $end, stepSeconds: $step) {
    samples { ts p50 p95 p99 }
  }
}`;

const DEPLOYMENT_QUERY = `query ($id: String!) { deployment(id: $id) { id serviceId environmentId } }`;
const LOGS_QUERY = (
  kind: 'deploy' | 'build',
) => `query ($id: String!, $limit: Int!, $filter: String) {
  logs: ${kind === 'build' ? 'buildLogs' : 'deploymentLogs'}(deploymentId: $id, limit: $limit, filter: $filter) {
    timestamp severity message
  }
}`;

type ApiServiceInstance = {
  region: string | null;
  numReplicas: number | null;
  restartPolicyType: string | null;
  restartPolicyMaxRetries: number | null;
  healthcheckPath: string | null;
  startCommand: string | null;
  rootDirectory: string | null;
  builder: string | null;
  sleepApplication: boolean | null;
  cronSchedule: string | null;
  nextCronRunAt: string | null;
  source: { repo: string | null; image: string | null } | null;
};
type ApiDeployDetail = ApiDeploy & { statusUpdatedAt: string | null };
type ApiMetric = { measurement: string; values: MetricPoint[] };
type ApiHttp = {
  httpMetricsGroupedByStatus: { statusCode: number; samples: MetricPoint[] }[];
  httpDurationMetrics: { samples: LatencyPoint[] };
};

/** Usługa musi być w środowisku tokenu — obcy id to „nie ma”, nie zapytanie w ciemno. */
function assertInScope(scope: RailwayScope, serviceId: string) {
  const instance = scope.instances.find((i) => i.serviceId === serviceId);
  if (!instance) {
    throw new IntegrationError(
      'Railway: nie ma takiej usługi w środowisku production',
    );
  }
  return instance;
}

/**
 * Szczegóły jednej usługi (ekran „System → usługa”): konfiguracja, 20
 * wdrożeń, domeny, zasoby w wybranym okresie i — jeśli usługa ma publiczny
 * adres — ruch HTTP wg klasy statusu z latencją.
 *
 * Metryki i HTTP to osobne zapytania z łagodną porażką: ich brak zostawia
 * pusty wykres, a nie gasi strony z konfiguracją i wdrożeniami.
 */
export async function fetchRailwayService(
  token: string,
  serviceId: string,
  range: OpsRange,
  fetchImpl: typeof fetch = globalThis.fetch,
  now: Date = new Date(),
): Promise<RailwayServiceDetail> {
  const gql = railwayGql(token, fetchImpl);
  const scope = await railwayScope(gql);
  const instance = assertInScope(scope, serviceId);
  const { ms, step } = OPS_RANGES[range];
  const window = {
    eid: scope.eid,
    sid: serviceId,
    start: new Date(now.getTime() - ms).toISOString(),
    end: now.toISOString(),
    step,
  };

  const [main, metrics] = await Promise.all([
    gql<{
      serviceInstance: ApiServiceInstance;
      deployments: { edges: { node: ApiDeployDetail }[] };
      domains: {
        serviceDomains: { domain: string }[];
        customDomains: { domain: string }[];
      };
    }>(SERVICE_QUERY, { pid: scope.pid, eid: scope.eid, sid: serviceId }),
    gql<{ metrics: ApiMetric[] }>(METRICS_QUERY, window)
      .then((d) => d.metrics)
      .catch((): ApiMetric[] => []),
  ]);

  const domains = [
    ...main.domains.customDomains.map((d) => d.domain),
    ...main.domains.serviceDomains.map((d) => d.domain),
  ];
  // Bez publicznego adresu nie ma ruchu HTTP — nie pytamy.
  const http = domains.length > 0 ? await fetchHttp(gql, window) : null;

  const series = (m: string) =>
    metrics.find((x) => x.measurement === m)?.values ?? [];
  const lastValue = (m: string) => {
    const values = series(m);
    return values.length ? values[values.length - 1].value : null;
  };
  const si = main.serviceInstance;

  return {
    id: serviceId,
    name: instance.serviceName,
    url: railwayServiceUrl(scope, serviceId),
    range,
    config: {
      region: si.region,
      replicas: si.numReplicas,
      restartPolicy: si.restartPolicyType,
      restartMaxRetries: si.restartPolicyMaxRetries,
      healthcheckPath: si.healthcheckPath,
      startCommand: si.startCommand,
      rootDirectory: si.rootDirectory,
      builder: si.builder,
      repo: si.source?.repo ?? null,
      image: si.source?.image ?? null,
      sleeps: si.sleepApplication === true,
      cron: si.cronSchedule,
      nextCronRunAt: si.nextCronRunAt,
      domains,
    },
    metrics: {
      cpu: series('CPU_USAGE'),
      memoryGb: series('MEMORY_USAGE_GB'),
      networkRxGb: series('NETWORK_RX_GB'),
      networkTxGb: series('NETWORK_TX_GB'),
      diskGb: series('DISK_USAGE_GB'),
      cpuLimit: lastValue('CPU_LIMIT'),
      memoryLimitGb: lastValue('MEMORY_LIMIT_GB'),
    },
    http,
    deploys: main.deployments.edges.map(
      ({ node }): RailwayDeployDetail => ({
        ...toDeploy(node),
        statusUpdatedAt: node.statusUpdatedAt ?? null,
      }),
    ),
  };
}

/** Żądania sklejone w klasy statusu (2xx…5xx) po znaczniku czasu. */
export function groupByStatusClass(
  groups: ApiHttp['httpMetricsGroupedByStatus'],
): NonNullable<RailwayServiceDetail['http']>['requests'] {
  const byTs = new Map<
    number,
    {
      ts: number;
      ok: number;
      redirect: number;
      clientError: number;
      serverError: number;
    }
  >();
  for (const group of groups) {
    const key =
      group.statusCode >= 500
        ? 'serverError'
        : group.statusCode >= 400
          ? 'clientError'
          : group.statusCode >= 300
            ? 'redirect'
            : 'ok';
    for (const { ts, value } of group.samples) {
      const point = byTs.get(ts) ?? {
        ts,
        ok: 0,
        redirect: 0,
        clientError: 0,
        serverError: 0,
      };
      point[key] += value;
      byTs.set(ts, point);
    }
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

async function fetchHttp(
  gql: RailwayGql,
  window: Record<string, unknown>,
): Promise<RailwayServiceDetail['http']> {
  try {
    const data = await gql<ApiHttp>(HTTP_QUERY, window);
    const requests = groupByStatusClass(data.httpMetricsGroupedByStatus);
    return requests.length === 0 &&
      data.httpDurationMetrics.samples.length === 0
      ? null
      : { requests, latency: data.httpDurationMetrics.samples };
  } catch {
    return null;
  }
}

/**
 * Logi wdrożenia albo budowania. Bez `deploymentId` — ostatnie wdrożenie
 * usługi. Wdrożenie spoza tej usługi to błąd, a nie cudze logi.
 */
export async function fetchRailwayLogs(
  token: string,
  serviceId: string,
  options: { deploymentId?: string; kind: 'deploy' | 'build'; filter?: string },
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<RailwayLogs> {
  const gql = railwayGql(token, fetchImpl);
  const scope = await railwayScope(gql);
  assertInScope(scope, serviceId);

  let deploymentId = options.deploymentId;
  if (deploymentId) {
    const { deployment } = await gql<{
      deployment: { serviceId: string; environmentId: string } | null;
    }>(DEPLOYMENT_QUERY, { id: deploymentId });
    if (
      !deployment ||
      deployment.serviceId !== serviceId ||
      deployment.environmentId !== scope.eid
    ) {
      throw new IntegrationError(
        'Railway: to wdrożenie nie należy do tej usługi',
      );
    }
  } else {
    const { deployments } = await gql<{
      deployments: { edges: { node: { id: string } }[] };
    }>(
      `query ($pid: String!, $eid: String!, $sid: String!) {
        deployments(first: 1, input: { projectId: $pid, environmentId: $eid, serviceId: $sid }) { edges { node { id } } }
      }`,
      { pid: scope.pid, eid: scope.eid, sid: serviceId },
    );
    deploymentId = deployments.edges[0]?.node.id;
    if (!deploymentId)
      return { deploymentId: '', kind: options.kind, lines: [] };
  }

  const { logs } = await gql<{
    logs: { timestamp: string; severity: string | null; message: string }[];
  }>(LOGS_QUERY(options.kind), {
    id: deploymentId,
    limit: LOG_LINES,
    filter: options.filter?.trim() || null,
  });

  return {
    deploymentId,
    kind: options.kind,
    lines: [...logs]
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .map((l) => ({
        timestamp: l.timestamp,
        severity: l.severity?.toLowerCase() || null,
        message: l.message,
      })),
  };
}
