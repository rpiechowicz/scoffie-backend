import { createPrivateKey, type KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';
import type {
  AppStoreData,
  AscBuild,
  AscReview,
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
 * App Store Connect API tylko do odczytu: buildy (Xcode Cloud / TestFlight),
 * wersje w sklepie i recenzje. Odpowiedź na recenzję — druga runda (decyzja
 * z 25.09.2026), wtedy z step-upem i audytem.
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
          body: responseBody,
          state: str(response?.attributes.state) ?? 'UNKNOWN',
        }
      : null,
  };
}
