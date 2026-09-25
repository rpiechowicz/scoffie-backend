import { Logger } from '@nestjs/common';
import type { TrafficCount, TrafficData, TrafficDay } from '../contract';
import { fetchJson, IntegrationError } from '../integrations/integration-fetch';

const logger = new Logger('AdminTraffic');

export const CLOUDFLARE_GRAPHQL_URL =
  'https://api.cloudflare.com/client/v4/graphql';

/** Okno ruchu w dniach. `httpRequestsAdaptiveGroups` na planie Free: ≤ 30 dni. */
export const TRAFFIC_DAYS = 30;
/** Strony serwisu — bez `img.`, `dashboard.` i `api.` z tej samej strefy. */
export const SITE_HOST = 'scoffie.app';
/** Landing zaproszeń w `scoffie-web` (`src/pages/zaproszenie/`), token we fragmencie. */
export const INVITE_PATHS = ['/zaproszenie', '/zaproszenie/'];

export type CloudflareEnv = { token: string; zoneId: string };

const DAY_MS = 86_400_000;

type GraphQlResponse<T> = {
  data?: { viewer?: { zones?: T[] } } | null;
  errors?: { message?: string }[] | null;
};

type DailyZone = {
  days?: {
    dimensions?: { date?: string };
    sum?: { requests?: number; pageViews?: number };
    uniq?: { uniques?: number };
  }[];
};

type AdaptiveZone = {
  paths?: { count?: number; dimensions?: { clientRequestPath?: string } }[];
  countries?: {
    count?: number;
    dimensions?: { clientCountryName?: string };
  }[];
  invites?: { count?: number; dimensions?: { date?: string } }[];
};

const DAILY_QUERY = `query Daily($zone: String!, $since: Date!) {
  viewer { zones(filter: { zoneTag: $zone }) {
    days: httpRequests1dGroups(limit: 40, orderBy: [date_ASC], filter: { date_geq: $since }) {
      dimensions { date }
      sum { requests pageViews }
      uniq { uniques }
    }
  } }
}`;

// Strony = ścieżki bez kropki (bez plików), z odpowiedzią < 400 (bez skanów
// `/wp-login.php` i 404), tylko host serwisu, tylko ruch od ludzi (`eyeball`).
const ADAPTIVE_QUERY = `query Adaptive($zone: String!, $from: Time!, $to: Time!, $host: String!, $invites: [String!]) {
  viewer { zones(filter: { zoneTag: $zone }) {
    paths: httpRequestsAdaptiveGroups(limit: 10, orderBy: [count_DESC], filter: {
      datetime_geq: $from, datetime_lt: $to, requestSource: "eyeball",
      clientRequestHTTPHost: $host, clientRequestPath_notlike: "%.%", edgeResponseStatus_lt: 400
    }) { count dimensions { clientRequestPath } }
    countries: httpRequestsAdaptiveGroups(limit: 10, orderBy: [count_DESC], filter: {
      datetime_geq: $from, datetime_lt: $to, requestSource: "eyeball",
      clientRequestHTTPHost: $host, clientRequestPath_notlike: "%.%", edgeResponseStatus_lt: 400
    }) { count dimensions { clientCountryName } }
    invites: httpRequestsAdaptiveGroups(limit: 40, orderBy: [date_ASC], filter: {
      datetime_geq: $from, datetime_lt: $to, requestSource: "eyeball",
      clientRequestHTTPHost: $host, clientRequestPath_in: $invites, edgeResponseStatus_lt: 400
    }) { count dimensions { date } }
  } }
}`;

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Ostatnie `TRAFFIC_DAYS` dni UTC, od najstarszego, dzisiejszy włącznie. */
export function trafficDates(now: Date): string[] {
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return Array.from({ length: TRAFFIC_DAYS }, (_, index) =>
    isoDay(new Date(today - (TRAFFIC_DAYS - 1 - index) * DAY_MS)),
  );
}

async function graphql<T>(
  env: CloudflareEnv,
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<T> {
  const { body } = await fetchJson<GraphQlResponse<T>>(
    'Cloudflare',
    CLOUDFLARE_GRAPHQL_URL,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    },
    fetchImpl,
  );
  const message = body.errors?.find((error) => error?.message)?.message;
  if (message) {
    throw new IntegrationError(`Cloudflare: ${message.slice(0, 200)}`);
  }
  const zone = body.data?.viewer?.zones?.[0];
  if (!zone) {
    throw new IntegrationError(
      'Cloudflare: brak strefy — sprawdź ADMIN_CLOUDFLARE_ZONE_ID i uprawnienia tokenu (Zone Analytics:Read)',
    );
  }
  return zone;
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

export function mapDays(zone: DailyZone, dates: string[]): TrafficDay[] {
  const byDate = new Map(
    (zone.days ?? []).map((row) => [row.dimensions?.date ?? '', row]),
  );
  return dates.map((date) => {
    const row = byDate.get(date);
    return {
      date,
      requests: count(row?.sum?.requests),
      visitors: count(row?.uniq?.uniques),
      pageViews: count(row?.sum?.pageViews),
    };
  });
}

export function mapAdaptive(
  zone: AdaptiveZone,
  dates: string[],
): Pick<TrafficData, 'paths' | 'countries' | 'invites'> {
  const counts = (
    rows: { count?: number; name?: string }[] | undefined,
  ): TrafficCount[] =>
    (rows ?? [])
      .filter((row) => row.name)
      .map((row) => ({ name: row.name as string, count: count(row.count) }));
  const inviteByDate = new Map<string, number>();
  for (const row of zone.invites ?? []) {
    const date = row.dimensions?.date;
    if (date)
      inviteByDate.set(date, (inviteByDate.get(date) ?? 0) + count(row.count));
  }
  const inviteDays = dates.map((date) => ({
    date,
    count: inviteByDate.get(date) ?? 0,
  }));
  return {
    paths: counts(
      zone.paths?.map((row) => ({
        count: row.count,
        name: row.dimensions?.clientRequestPath,
      })),
    ),
    countries: counts(
      zone.countries?.map((row) => ({
        count: row.count,
        name: row.dimensions?.clientCountryName,
      })),
    ),
    invites: {
      total: inviteDays.reduce((sum, day) => sum + day.count, 0),
      days: inviteDays,
    },
  };
}

/**
 * Ruch strefy z Cloudflare GraphQL Analytics. Dzienne liczby
 * (`httpRequests1dGroups`) są wymagane — ich błąd to `error` całej
 * integracji. Rozbicie po ścieżkach, krajach i wejścia na zaproszenia
 * (`httpRequestsAdaptiveGroups`) jest dodatkiem: gdy plan albo token go
 * nie obejmują, te pola wracają jako `null`, a wykres zostaje.
 */
export async function fetchTraffic(
  env: CloudflareEnv,
  now: Date = new Date(),
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<TrafficData> {
  const dates = trafficDates(now);
  const daily = await graphql<DailyZone>(
    env,
    DAILY_QUERY,
    { zone: env.zoneId, since: dates[0] },
    fetchImpl,
  );
  let adaptive: Pick<TrafficData, 'paths' | 'countries' | 'invites'> = {
    paths: null,
    countries: null,
    invites: null,
  };
  try {
    // Okno odrobinę krótsze niż 30 dni — limit planu Free to równo 30 dni
    // (`maxDuration` 2 592 000 s), a zegar Cloudflare nie jest naszym zegarem.
    const zone = await graphql<AdaptiveZone>(
      env,
      ADAPTIVE_QUERY,
      {
        zone: env.zoneId,
        from: new Date(now.getTime() - TRAFFIC_DAYS * DAY_MS + 3_600_000),
        to: now,
        host: SITE_HOST,
        invites: INVITE_PATHS,
      },
      fetchImpl,
    );
    adaptive = mapAdaptive(zone, dates);
  } catch (error) {
    logger.warn(
      `ruch: rozbicie po ścieżkach niedostępne — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { days: mapDays(daily, dates), ...adaptive };
}
