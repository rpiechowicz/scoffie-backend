import type { SentryData, SentryIssue, SentryProjectHealth } from '../contract';
import { fetchJson, IntegrationError } from './integration-fetch';
import type { SentryEnv } from './integrations-env';

const ISSUE_LIMIT = 15;
const UNRESOLVED = 'is:unresolved';
const NEW_24H = 'is:unresolved firstSeen:-24h';

type ApiProject = { id: string; slug: string };
type ApiIssue = {
  id: string;
  shortId: string;
  title: string;
  culprit?: string | null;
  level?: string;
  count?: string | number;
  userCount?: number;
  firstSeen: string;
  lastSeen: string;
  permalink: string;
  project?: { slug?: string };
  stats?: Record<string, [number, number][]>;
};
type ApiSessions = {
  groups?: { totals?: Record<string, number | null> }[];
};

/**
 * Sentry (region DE) tylko do odczytu: zdrowie wydań i problemy z 24 h.
 * Token organizacji z zakresami `org:read`, `project:read`, `event:read`.
 *
 * Trzy rodzaje zapytań, wszystkie z publicznego API 0:
 *   - `/organizations/{org}/projects/` — slug → numeryczne id (filtry chcą id),
 *   - `/organizations/{org}/issues-count/` — liczniki kart „nierozwiązane”
 *     i „nowe z 24 h” jednym wywołaniem na projekt,
 *   - `/organizations/{org}/sessions/` — crash-free; projekt bez sesji
 *     (backend, panel) oddaje puste grupy → `null`, a nie 100 %.
 */
export async function fetchSentry(
  env: SentryEnv,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<SentryData> {
  const base = `${env.apiUrl}/api/0/organizations/${encodeURIComponent(env.org)}`;
  const get = <T>(path: string) =>
    fetchJson<T>(
      'Sentry',
      `${base}${path}`,
      {
        headers: {
          authorization: `Bearer ${env.token}`,
          accept: 'application/json',
        },
      },
      fetchImpl,
    );

  const { body: all } = await get<ApiProject[]>('/projects/?per_page=100');
  const projects = env.projects
    .map((slug) => all.find((p) => p.slug === slug))
    .filter((p): p is ApiProject => p !== undefined);
  if (projects.length === 0) {
    throw new IntegrationError(
      `Sentry: token nie widzi żadnego z projektów ${env.projects.join(', ')}`,
    );
  }

  const projectParams = projects.map((p) => `project=${p.id}`).join('&');
  const [health, issues] = await Promise.all([
    Promise.all(projects.map((p) => projectHealth(p, get))),
    get<ApiIssue[]>(
      `/issues/?${new URLSearchParams({ query: UNRESOLVED, statsPeriod: '24h', sort: 'freq', limit: String(ISSUE_LIMIT) })}&${projectParams}`,
    ).then(({ body }) => body.map(toIssue)),
  ]);

  return {
    projects: health,
    issues,
    url: `https://${env.org}.sentry.io/issues/`,
  };
}

async function projectHealth(
  project: ApiProject,
  get: <T>(path: string) => Promise<{ body: T }>,
): Promise<SentryProjectHealth> {
  const counts = new URLSearchParams({
    statsPeriod: '24h',
    project: project.id,
  });
  counts.append('query', UNRESOLVED);
  counts.append('query', NEW_24H);
  const sessions = new URLSearchParams({
    project: project.id,
    statsPeriod: '24h',
    interval: '1d',
  });
  sessions.append('field', 'crash_free_rate(session)');
  sessions.append('field', 'crash_free_rate(user)');

  const [{ body: count }, rates] = await Promise.all([
    get<Record<string, number>>(`/issues-count/?${counts}`),
    // Brak sesji w projekcie bywa 400 zamiast pustych grup — to nie awaria.
    get<ApiSessions>(`/sessions/?${sessions}`)
      .then(
        ({ body }): Record<string, number | null> =>
          body.groups?.[0]?.totals ?? {},
      )
      .catch((error: unknown): Record<string, number | null> => {
        if (error instanceof IntegrationError && /HTTP 400/.test(error.message))
          return {};
        throw error;
      }),
  ]);

  return {
    slug: project.slug,
    crashFreeUsers: percent(rates['crash_free_rate(user)']),
    crashFreeSessions: percent(rates['crash_free_rate(session)']),
    unresolved: count[UNRESOLVED] ?? 0,
    new24h: count[NEW_24H] ?? 0,
  };
}

/** Sentry oddaje ułamek 0–1 albo `null`, gdy w oknie nie było sesji. */
function percent(rate: number | null | undefined): number | null {
  return typeof rate === 'number' ? Math.round(rate * 10_000) / 100 : null;
}

export function toIssue(issue: ApiIssue): SentryIssue {
  // `count` to całe życie problemu; zdarzenia z okna są w `stats['24h']`.
  const window = issue.stats?.['24h'];
  const count = window
    ? window.reduce((sum, [, n]) => sum + n, 0)
    : Number(issue.count ?? 0);
  return {
    id: issue.id,
    shortId: issue.shortId,
    title: issue.title,
    culprit: issue.culprit || null,
    level: issue.level ?? 'error',
    project: issue.project?.slug ?? '',
    count,
    userCount: issue.userCount ?? 0,
    firstSeen: issue.firstSeen,
    lastSeen: issue.lastSeen,
    permalink: issue.permalink,
  };
}
