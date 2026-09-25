import type {
  MetricPoint,
  RailwayData,
  RailwayDeploy,
  RailwayService,
} from '../contract';
import { fetchJson, IntegrationError } from './integration-fetch';

const ENDPOINT = 'https://backboard.railway.com/graphql/v2';
const DEPLOYS = 5;
const METRICS_WINDOW_MS = 24 * 60 * 60 * 1000;
const METRICS_SAMPLE_SECONDS = 1800;

type Gql<T> = { data?: T; errors?: { message: string }[] };

export type ApiDeploy = {
  id: string;
  status: string;
  createdAt: string;
  meta?: Record<string, unknown> | null;
};

export type RailwayGql = <T>(
  query: string,
  variables?: Record<string, unknown>,
) => Promise<T>;

/** Jedno zapytanie GraphQL tokenem projektu; błąd w odpowiedzi 200 też rzuca. */
export function railwayGql(
  token: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): RailwayGql {
  return async <T>(query: string, variables: Record<string, unknown> = {}) => {
    const { body } = await fetchJson<Gql<T>>(
      'Railway',
      ENDPOINT,
      {
        method: 'POST',
        headers: {
          'project-access-token': token,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      },
      fetchImpl,
    );
    if (body.errors?.length || !body.data) {
      throw new IntegrationError(
        `Railway: ${body.errors?.map((e) => e.message).join('; ') || 'pusta odpowiedź'}`,
      );
    }
    return body.data;
  };
}

const TOKEN_QUERY = `query { projectToken { projectId environmentId } }`;

/**
 * Usługi ŚRODOWISKA, nie projektu: usługa dodana w projekcie, ale nigdy nie
 * uruchomiona w production (np. świeży cron), nie ma tu instancji — pytanie
 * o nią kończyło się „ServiceInstance not found” i gasiło całą kartę.
 */
const ENVIRONMENT_QUERY = `query ($eid: String!) {
  environment(id: $eid) {
    serviceInstances { edges { node { serviceId serviceName cronSchedule nextCronRunAt } } }
  }
}`;

export type ApiInstance = {
  serviceId: string;
  serviceName: string;
  cronSchedule: string | null;
  nextCronRunAt: string | null;
};

const DEPLOYS_QUERY = `query ($pid: String!, $eid: String!, $sid: String!) {
  deployments(first: ${DEPLOYS}, input: { projectId: $pid, environmentId: $eid, serviceId: $sid }) {
    edges { node { id status createdAt meta } }
  }
}`;

type ApiMetric = {
  measurement: string;
  tags: { serviceId: string | null };
  values: MetricPoint[];
};

const METRICS_QUERY = `query ($pid: String!, $eid: String!, $start: DateTime!) {
  metrics(projectId: $pid, environmentId: $eid, startDate: $start,
    measurements: [CPU_USAGE, MEMORY_USAGE_GB], groupBy: [SERVICE_ID],
    sampleRateSeconds: ${METRICS_SAMPLE_SECONDS}) {
    measurement tags { serviceId } values { ts value }
  }
}`;

export type RailwayScope = {
  pid: string;
  eid: string;
  instances: ApiInstance[];
};

/** Projekt i środowisko z tokenu + usługi, które w nim naprawdę są. */
export async function railwayScope(gql: RailwayGql): Promise<RailwayScope> {
  const { projectToken } = await gql<{
    projectToken: { projectId: string; environmentId: string };
  }>(TOKEN_QUERY);
  const { projectId: pid, environmentId: eid } = projectToken;
  const { environment } = await gql<{
    environment: { serviceInstances: { edges: { node: ApiInstance }[] } };
  }>(ENVIRONMENT_QUERY, { eid });
  return {
    pid,
    eid,
    instances: environment.serviceInstances.edges.map((e) => e.node),
  };
}

export const railwayServiceUrl = (scope: RailwayScope, serviceId: string) =>
  `https://railway.com/project/${scope.pid}/service/${serviceId}?environmentId=${scope.eid}`;

/**
 * Railway (publiczne API GraphQL) tylko do odczytu, tokenem PROJEKTU
 * (`Project-Access-Token`) — token widzi jeden projekt i jedno środowisko,
 * a te zna sam (`projectToken`), więc nic nie trzeba konfigurować obok.
 *
 * Bez mutacji: redeploy i restart zostają w Railwayu (decyzja z 25.09.2026 —
 * przejęta sesja panelu nie może położyć produkcji).
 */
export async function fetchRailway(
  token: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  now: Date = new Date(),
): Promise<RailwayData> {
  const gql = railwayGql(token, fetchImpl);
  const scope = await railwayScope(gql);
  const { pid, eid } = scope;

  // Metryki to ozdoba karty — ich brak nie może zasłonić stanu deployów.
  const metrics = await gql<{ metrics: ApiMetric[] }>(METRICS_QUERY, {
    pid,
    eid,
    start: new Date(now.getTime() - METRICS_WINDOW_MS).toISOString(),
  })
    .then((d) => d.metrics)
    .catch((): ApiMetric[] => []);

  const series = (serviceId: string, measurement: string): MetricPoint[] =>
    metrics.find(
      (m) => m.tags.serviceId === serviceId && m.measurement === measurement,
    )?.values ?? [];

  const services = await Promise.all(
    scope.instances.map(async (node): Promise<RailwayService> => {
      const { deployments } = await gql<{
        deployments: { edges: { node: ApiDeploy }[] };
      }>(DEPLOYS_QUERY, { pid, eid, sid: node.serviceId });
      return {
        id: node.serviceId,
        name: node.serviceName,
        cron: node.cronSchedule,
        nextCronRunAt: node.nextCronRunAt,
        deploys: deployments.edges.map((e) => toDeploy(e.node)),
        cpu: series(node.serviceId, 'CPU_USAGE'),
        memoryGb: series(node.serviceId, 'MEMORY_USAGE_GB'),
        url: railwayServiceUrl(scope, node.serviceId),
      };
    }),
  );

  return { services: services.sort((a, b) => a.name.localeCompare(b.name)) };
}

export const metaText = (
  meta: ApiDeploy['meta'],
  key: string,
): string | null => {
  const value = meta?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

export function toDeploy(d: ApiDeploy): RailwayDeploy {
  return {
    id: d.id,
    status: d.status,
    createdAt: d.createdAt,
    commitHash: metaText(d.meta, 'commitHash'),
    commitMessage: metaText(d.meta, 'commitMessage'),
    branch: metaText(d.meta, 'branch'),
  };
}
