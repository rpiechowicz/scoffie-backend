import type {
  SentryData,
  SentryIssue,
  SentryProjectHealth,
  SentryUserData,
  SentryUserEvent,
} from '../contract';
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
 *     (backend, panel) oddaje puste grupy → `null`, a nie 100 %,
 *   - `/organizations/{org}/stats_v2/` — przyjęte zdarzenia z 24 h, jedno
 *     zapytanie dla wszystkich projektów,
 *   - `/organizations/{org}/releases/` — najnowsze wydanie projektu.
 * Statystyki i wydania to dodatki: ich porażka daje `null`, nie błąd karty.
 */
export async function fetchSentry(
  env: SentryEnv,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<SentryData> {
  const get = sentryGet(env, fetchImpl);
  const { projects, missing, projectParams } = await sentryProjects(env, get);
  const events = await eventsPerProject(get, projectParams);
  const [health, issues] = await Promise.all([
    Promise.all(projects.map((p) => projectHealth(p, get, events))),
    get<ApiIssue[]>(
      `/issues/?${new URLSearchParams({ query: UNRESOLVED, statsPeriod: '24h', sort: 'freq', limit: String(ISSUE_LIMIT) })}&${projectParams}`,
    ).then(({ body }) => body.map((issue) => toIssue(issue))),
  ]);

  return {
    projects: health,
    issues,
    url: `https://${env.org}.sentry.io/issues/`,
    missing,
  };
}

type SentryGet = <T>(path: string) => Promise<{ body: T; headers: Headers }>;

/** GET w API organizacji — token w nagłówku, limit czasu z `fetchJson`. */
export function sentryGet(
  env: SentryEnv,
  fetchImpl: typeof fetch = globalThis.fetch,
): SentryGet {
  const base = `${env.apiUrl}/api/0/organizations/${encodeURIComponent(env.org)}`;
  return <T>(path: string) =>
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
}

/**
 * Projekty z `ADMIN_SENTRY_PROJECTS`, które token widzi (slug → numeryczne
 * id, bo filtry chcą id), i gotowy fragment `project=…&project=…`.
 */
async function sentryProjects(
  env: SentryEnv,
  get: SentryGet,
): Promise<{
  projects: ApiProject[];
  missing: string[];
  projectParams: string;
}> {
  const { body: all } = await get<ApiProject[]>('/projects/?per_page=100');
  const projects = env.projects
    .map((slug) => all.find((p) => p.slug === slug))
    .filter((p): p is ApiProject => p !== undefined);
  if (projects.length === 0) {
    throw new IntegrationError(
      `Sentry: token nie widzi żadnego z projektów ${env.projects.join(', ')}`,
    );
  }
  const missing = env.projects.filter(
    (slug) => !all.some((p) => p.slug === slug),
  );
  const projectParams = projects.map((p) => `project=${p.id}`).join('&');
  return { projects, missing, projectParams };
}

const USER_PERIOD = '14d';
const USER_ISSUE_LIMIT = 25;
const USER_EVENT_LIMIT = 20;
const USER_EVENT_FIELDS = [
  'id',
  'title',
  'level',
  'project',
  'release',
  'timestamp',
  'issue.id',
] as const;

type ApiEventRow = Partial<
  Record<(typeof USER_EVENT_FIELDS)[number] | 'project.name', unknown>
>;

/**
 * Błędy JEDNEJ osoby z 14 dni — iOS (i backend) ustawia w Sentry
 * `user.id` = id konta, więc wystarczy wyszukiwanie po tym tagu:
 *   - `/issues/?query=user.id:<id>` — problemy, w których osoba ma zdarzenie,
 *     z licznikiem z 14 dni (`groupStatsPeriod=14d`),
 *   - `/events/?field=…&query=user.id:<id>` (Discover, zbiór `errors`) —
 *     ostatnie zdarzenia z wydaniem aplikacji.
 * Zdarzenia to dodatek: ich porażka daje `eventsUnavailable`, nie błąd karty
 * (Discover bywa wyłączony w planie albo odrzuca pole, którego nie zna).
 *
 * `userId` to UUID sprawdzony przez kontroler — wchodzi do zapytania bez
 * cudzysłowów, bez możliwości doklejenia innego warunku.
 */
export async function fetchSentryUser(
  env: SentryEnv,
  userId: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<SentryUserData> {
  const get = sentryGet(env, fetchImpl);
  const { projectParams } = await sentryProjects(env, get);
  const query = `user.id:${userId}`;

  const issueParams = new URLSearchParams({
    query,
    statsPeriod: USER_PERIOD,
    groupStatsPeriod: USER_PERIOD,
    sort: 'date',
    limit: String(USER_ISSUE_LIMIT),
  });
  const eventParams = new URLSearchParams({
    query,
    statsPeriod: USER_PERIOD,
    sort: '-timestamp',
    per_page: String(USER_EVENT_LIMIT),
    dataset: 'errors',
  });
  for (const field of USER_EVENT_FIELDS) eventParams.append('field', field);

  const [issues, events] = await Promise.all([
    get<ApiIssue[]>(`/issues/?${issueParams}&${projectParams}`).then(
      ({ body }) =>
        (Array.isArray(body) ? body : []).map((issue) =>
          toIssue(issue, USER_PERIOD),
        ),
    ),
    get<{ data?: ApiEventRow[] }>(`/events/?${eventParams}&${projectParams}`)
      .then(({ body }) =>
        (Array.isArray(body?.data) ? body.data : [])
          .map((row) => toUserEvent(env, row))
          .filter((event): event is SentryUserEvent => event !== null),
      )
      .catch((): null => null),
  ]);

  return {
    issues,
    events: events ?? [],
    eventsUnavailable: events === null,
    url: `https://${env.org}.sentry.io/issues/?${new URLSearchParams({ query, statsPeriod: USER_PERIOD })}`,
  };
}

const str = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : null;

/** Wiersz Discover → zdarzenie; wiersz bez id albo czasu odpada. */
function toUserEvent(env: SentryEnv, row: ApiEventRow): SentryUserEvent | null {
  const id = str(row.id);
  const at = str(row.timestamp);
  if (!id || !at) return null;
  const project = str(row.project) ?? str(row['project.name']) ?? '';
  const issueId =
    typeof row['issue.id'] === 'number'
      ? String(row['issue.id'])
      : str(row['issue.id']);
  const origin = `https://${env.org}.sentry.io`;
  return {
    id,
    title: str(row.title) ?? '(bez tytułu)',
    level: str(row.level) ?? 'error',
    project,
    release: str(row.release),
    at,
    permalink: issueId
      ? `${origin}/issues/${encodeURIComponent(issueId)}/events/${encodeURIComponent(id)}/`
      : `${origin}/discover/${encodeURIComponent(project)}:${encodeURIComponent(id)}/`,
  };
}

type ApiStats = {
  groups?: {
    by?: { project?: number | string };
    totals?: Record<string, number>;
  }[];
};

/** Przyjęte zdarzenia błędów z 24 h wg id projektu; porażka = pusta mapa. */
async function eventsPerProject(
  get: SentryGet,
  projectParams: string,
): Promise<Map<string, number> | null> {
  const query = new URLSearchParams({
    field: 'sum(quantity)',
    groupBy: 'project',
    category: 'error',
    outcome: 'accepted',
    statsPeriod: '24h',
    interval: '1d',
  });
  try {
    const { body } = await get<ApiStats>(
      `/stats_v2/?${query}&${projectParams}`,
    );
    return new Map(
      (body.groups ?? []).map((g) => [
        String(g.by?.project ?? ''),
        g.totals?.['sum(quantity)'] ?? 0,
      ]),
    );
  } catch {
    return null;
  }
}

type ApiRelease = { version: string; dateCreated: string };

async function projectHealth(
  project: ApiProject,
  get: SentryGet,
  events: Map<string, number> | null,
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

  const [{ body: count }, rates, release] = await Promise.all([
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
    get<ApiRelease[]>(`/releases/?project=${project.id}&per_page=1`)
      .then(({ body }) =>
        body[0]
          ? { version: body[0].version, createdAt: body[0].dateCreated }
          : null,
      )
      .catch(() => null),
  ]);

  return {
    slug: project.slug,
    crashFreeUsers: percent(rates['crash_free_rate(user)']),
    crashFreeSessions: percent(rates['crash_free_rate(session)']),
    unresolved: count[UNRESOLVED] ?? 0,
    new24h: count[NEW_24H] ?? 0,
    events24h: events ? (events.get(project.id) ?? 0) : null,
    release,
  };
}

/** Sentry oddaje ułamek 0–1 albo `null`, gdy w oknie nie było sesji. */
function percent(rate: number | null | undefined): number | null {
  return typeof rate === 'number' ? Math.round(rate * 10_000) / 100 : null;
}

export function toIssue(issue: ApiIssue, period = '24h'): SentryIssue {
  // `count` to całe życie problemu; zdarzenia z okna są w `stats[okres]`.
  const window = issue.stats?.[period];
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
