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

type ApiDeploy = {
  id: string;
  status: string;
  createdAt: string;
  meta?: Record<string, unknown> | null;
};

const TOKEN_QUERY = `query { projectToken { projectId environmentId } }`;

const PROJECT_QUERY = `query ($id: String!) {
  project(id: $id) { services { edges { node { id name } } } }
}`;

const SERVICE_QUERY = `query ($pid: String!, $eid: String!, $sid: String!) {
  serviceInstance(serviceId: $sid, environmentId: $eid) { cronSchedule nextCronRunAt }
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
  const gql = async <T>(
    query: string,
    variables: Record<string, unknown> = {},
  ) => {
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

  const { projectToken } = await gql<{
    projectToken: { projectId: string; environmentId: string };
  }>(TOKEN_QUERY);
  const { projectId: pid, environmentId: eid } = projectToken;

  const [{ project }, metrics] = await Promise.all([
    gql<{
      project: {
        services: { edges: { node: { id: string; name: string } }[] };
      };
    }>(PROJECT_QUERY, { id: pid }),
    // Metryki to ozdoba karty — ich brak nie może zasłonić stanu deployów.
    gql<{ metrics: ApiMetric[] }>(METRICS_QUERY, {
      pid,
      eid,
      start: new Date(now.getTime() - METRICS_WINDOW_MS).toISOString(),
    })
      .then((d) => d.metrics)
      .catch((): ApiMetric[] => []),
  ]);

  const series = (serviceId: string, measurement: string): MetricPoint[] =>
    metrics.find(
      (m) => m.tags.serviceId === serviceId && m.measurement === measurement,
    )?.values ?? [];

  const services = await Promise.all(
    project.services.edges.map(async ({ node }): Promise<RailwayService> => {
      const data = await gql<{
        serviceInstance: {
          cronSchedule: string | null;
          nextCronRunAt: string | null;
        } | null;
        deployments: { edges: { node: ApiDeploy }[] };
      }>(SERVICE_QUERY, { pid, eid, sid: node.id });
      return {
        id: node.id,
        name: node.name,
        cron: data.serviceInstance?.cronSchedule ?? null,
        nextCronRunAt: data.serviceInstance?.nextCronRunAt ?? null,
        deploys: data.deployments.edges.map((e) => toDeploy(e.node)),
        cpu: series(node.id, 'CPU_USAGE'),
        memoryGb: series(node.id, 'MEMORY_USAGE_GB'),
        url: `https://railway.com/project/${pid}/service/${node.id}?environmentId=${eid}`,
      };
    }),
  );

  return { services: services.sort((a, b) => a.name.localeCompare(b.name)) };
}

const metaText = (meta: ApiDeploy['meta'], key: string): string | null => {
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
