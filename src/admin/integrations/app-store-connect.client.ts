import { createPrivateKey, type KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';
import type {
  AppStoreData,
  AscBuild,
  AscReview,
  AscReviewResponse,
  AscVersion,
} from '../contract';
import { fetchJson, IntegrationError } from './integration-fetch';
import type { AscEnv } from './integrations-env';

const API = 'https://api.appstoreconnect.apple.com/v1';

type Resource<
  A,
  R = Record<string, { data: { id: string; type: string } | null }>,
> = {
  id: string;
  type: string;
  attributes: A;
  relationships?: R;
};
type Doc<A> = {
  data: Resource<A>[];
  included?: Resource<Record<string, unknown>>[];
};

/**
 * App Store Connect API: buildy (Xcode Cloud / TestFlight), wersje w sklepie
 * i recenzje. Jedyny zapis to odpowiedź na recenzję (`respondToReview`,
 * `deleteReviewResponse` niżej) — ze step-upem i audytem w serwisie.
 *
 * Token jak w `AppStoreServerClient`: ES256 kluczem `.p8`, 5 minut, nowy na
 * każde odświeżenie — ale BEZ `bid` (to claim App Store Server API).
 */
export async function fetchAppStore(
  env: AscEnv,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<AppStoreData> {
  const token = await ascToken(env);
  const get = <A>(path: string) =>
    fetchJson<Doc<A>>(
      'App Store Connect',
      `${API}${path}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
        },
      },
      fetchImpl,
    ).then((r) => r.body);

  const apps = await get<{ name: string; bundleId: string }>(
    `/apps?${new URLSearchParams({ 'filter[bundleId]': env.bundleId, 'fields[apps]': 'name,bundleId' })}`,
  );
  const app = apps.data[0];
  if (!app) {
    throw new IntegrationError(
      `App Store Connect: klucz nie widzi aplikacji ${env.bundleId}`,
    );
  }
  const appId = encodeURIComponent(app.id);

  const [builds, versions, reviews] = await Promise.all([
    get<{
      version: string;
      uploadedDate: string;
      processingState: string;
      expired: boolean;
    }>(
      `/builds?${new URLSearchParams({
        'filter[app]': app.id,
        sort: '-uploadedDate',
        limit: '10',
        include: 'preReleaseVersion',
        'fields[builds]':
          'version,uploadedDate,processingState,expired,preReleaseVersion',
        'fields[preReleaseVersions]': 'version',
      })}`,
    ),
    get<{
      versionString: string;
      appVersionState?: string;
      appStoreState?: string;
      createdDate: string;
    }>(
      `/apps/${appId}/appStoreVersions?${new URLSearchParams({
        limit: '5',
        'fields[appStoreVersions]':
          'versionString,appVersionState,appStoreState,createdDate',
      })}`,
    ),
    get<{
      rating: number;
      title?: string;
      body?: string;
      reviewerNickname?: string;
      territory?: string;
      createdDate: string;
    }>(
      `/apps/${appId}/customerReviews?${new URLSearchParams({
        sort: '-createdDate',
        limit: '20',
        include: 'response',
        'fields[customerReviews]':
          'rating,title,body,reviewerNickname,territory,createdDate,response',
        'fields[customerReviewResponses]': 'responseBody,state',
      })}`,
    ),
  ]);

  return {
    app: {
      id: app.id,
      name: app.attributes.name,
      bundleId: app.attributes.bundleId,
    },
    builds: builds.data.map((b) => toBuild(b, builds.included)),
    versions: versions.data
      .map(toVersion)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    reviews: reviews.data.map((r) => toReview(r, reviews.included)),
    url: `https://appstoreconnect.apple.com/apps/${app.id}/distribution`,
  };
}

async function ascToken(env: AscEnv): Promise<string> {
  let key: KeyObject;
  try {
    key = createPrivateKey(env.privateKey);
  } catch {
    // Urwany albo źle wklejony `.p8` — błąd konfiguracji, nie awaria Apple.
    throw new IntegrationError(
      'App Store Connect: nie da się odczytać ADMIN_ASC_PRIVATE_KEY (sprawdź, czy wklejono cały plik .p8)',
    );
  }
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: env.keyId, typ: 'JWT' })
    .setIssuer(env.issuerId)
    .setAudience('appstoreconnect-v1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}

const related = (
  resource: Resource<unknown>,
  name: string,
  included: Doc<unknown>['included'],
) => {
  const ref = resource.relationships?.[name]?.data;
  return ref
    ? included?.find((i) => i.type === ref.type && i.id === ref.id)
    : undefined;
};

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

export function toBuild(
  b: Resource<{
    version: string;
    uploadedDate: string;
    processingState: string;
    expired: boolean;
  }>,
  included: Doc<unknown>['included'],
): AscBuild {
  return {
    id: b.id,
    build: b.attributes.version,
    version: str(related(b, 'preReleaseVersion', included)?.attributes.version),
    processingState: b.attributes.processingState,
    uploadedAt: b.attributes.uploadedDate,
    expired: b.attributes.expired,
  };
}

export function toVersion(
  v: Resource<{
    versionString: string;
    appVersionState?: string;
    appStoreState?: string;
    createdDate: string;
  }>,
): AscVersion {
  return {
    id: v.id,
    version: v.attributes.versionString,
    // `appStoreState` Apple wycofuje na rzecz `appVersionState`.
    state:
      v.attributes.appVersionState ?? v.attributes.appStoreState ?? 'UNKNOWN',
    createdAt: v.attributes.createdDate,
  };
}

export function toReview(
  r: Resource<{
    rating: number;
    title?: string;
    body?: string;
    reviewerNickname?: string;
    territory?: string;
    createdDate: string;
  }>,
  included: Doc<unknown>['included'],
): AscReview {
  const response = related(r, 'response', included);
  const responseBody = str(response?.attributes.responseBody);
  return {
    id: r.id,
    rating: r.attributes.rating,
    title: str(r.attributes.title),
    body: str(r.attributes.body),
    reviewer: str(r.attributes.reviewerNickname),
    territory: str(r.attributes.territory),
    createdAt: r.attributes.createdDate,
    response: responseBody
      ? {
          id: response?.id ?? '',
          body: responseBody,
          state: str(response?.attributes.state) ?? 'UNKNOWN',
        }
      : null,
  };
}

/**
 * Limit długości odpowiedzi na recenzję. API go nie dokumentuje (schemat
 * `responseBody` to goły `string`) — 5970 znaków to limit pola odpowiedzi
 * w App Store Connect; dłuższy tekst Apple odrzuca 409.
 */
export const ASC_RESPONSE_MAX_LENGTH = 5970;

/** Odmowa Apple przy zapisie — z kodem HTTP, żeby serwis dobrał komunikat. */
export class AscWriteError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AscWriteError';
  }
}

type AscErrorDoc = { errors?: { title?: string; detail?: string }[] };

async function ascSend<T>(
  env: AscEnv,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<T | null> {
  const token = await ascToken(env);
  let res: Response;
  try {
    res = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new AscWriteError(
      `App Store Connect nie odpowiada (${error instanceof Error ? error.name : 'sieć'})`,
      0,
    );
  }
  if (!res.ok) {
    const doc = (await res.json().catch(() => null)) as AscErrorDoc | null;
    const first = doc?.errors?.[0];
    const detail = (first?.detail ?? first?.title ?? '').slice(0, 200).trim();
    throw new AscWriteError(
      `App Store Connect: HTTP ${res.status}${detail ? ` · ${detail}` : ''}`,
      res.status,
    );
  }
  if (res.status === 204) return null;
  return (await res.json().catch(() => null)) as T | null;
}

/**
 * Odpowiedź na recenzję. `POST /v1/customerReviewResponses` tworzy ALBO
 * zastępuje istniejącą odpowiedź — „Edytuj” to ten sam zapis.
 */
export async function respondToReview(
  env: AscEnv,
  reviewId: string,
  responseBody: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<AscReviewResponse> {
  const doc = await ascSend<{
    data: Resource<{ responseBody?: string; state?: string }>;
  }>(
    env,
    'POST',
    '/customerReviewResponses',
    {
      data: {
        type: 'customerReviewResponses',
        attributes: { responseBody },
        relationships: {
          review: { data: { type: 'customerReviews', id: reviewId } },
        },
      },
    },
    fetchImpl,
  );
  return {
    id: doc?.data.id ?? '',
    body: str(doc?.data.attributes.responseBody) ?? responseBody,
    state: str(doc?.data.attributes.state) ?? 'PENDING_PUBLISH',
  };
}

/**
 * Usunięcie odpowiedzi. Id odpowiedzi bierzemy od Apple (relacja
 * `response` recenzji), a nie od klienta — panel wskazuje tylko recenzję.
 */
export async function deleteReviewResponse(
  env: AscEnv,
  reviewId: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> {
  const doc = await ascSend<{ data: Resource<unknown> | null }>(
    env,
    'GET',
    `/customerReviews/${encodeURIComponent(reviewId)}/response?${new URLSearchParams({ 'fields[customerReviewResponses]': 'state' })}`,
    undefined,
    fetchImpl,
  );
  const responseId = doc?.data?.id;
  if (!responseId) {
    throw new AscWriteError('Ta recenzja nie ma odpowiedzi.', 404);
  }
  await ascSend(
    env,
    'DELETE',
    `/customerReviewResponses/${encodeURIComponent(responseId)}`,
    undefined,
    fetchImpl,
  );
}
