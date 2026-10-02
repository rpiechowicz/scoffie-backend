import { effectiveProcessEnv } from './runtime-overrides';

/**
 * Minimalna wersja aplikacji (2.10.2026) — wyłącznik dla starych buildów.
 *
 * Wydanej wersji nie da się z telefonu wycofać: bez tego progu build z błędem
 * albo ze starym kontraktem API zostaje u ludzi na zawsze. Telefon pyta
 * `GET /public/app-version` przy starcie i po powrocie z tła; gdy serwer
 * powie `updateRequired`, aplikacja zasłania się ekranem „Zaktualizuj”.
 *
 * Próg ustawia się w panelu (Sterowanie, `APP_MIN_VERSION_*`) albo zmienną
 * na Railwayu; brak / `off` = bez progu. Wszystko, czego nie da się odczytać
 * (zła wartość, brak wersji w pytaniu), PRZEPUSZCZA — wyłącznik nie może
 * przez literówkę zamknąć aplikacji wszystkim.
 */
export const APP_PLATFORMS = ['ios', 'android'] as const;
export type AppPlatform = (typeof APP_PLATFORMS)[number];

export const APP_MIN_VERSION_KEYS = {
  ios: 'APP_MIN_VERSION_IOS',
  android: 'APP_MIN_VERSION_ANDROID',
} as const satisfies Record<AppPlatform, string>;

/** Strona aplikacji w sklepie — przycisk „Zaktualizuj”. */
export const APP_STORE_URLS: Record<AppPlatform, string> = {
  ios: 'https://apps.apple.com/app/id6808608589',
  android: 'https://play.google.com/store/apps/details?id=app.scoffie.android',
};

/** `1`, `1.2`, `1.2.3` — tak jak `CFBundleShortVersionString` i `versionName`. */
const VERSION = /^\d{1,4}(?:\.\d{1,4}){0,2}$/;

/**
 * Wartość progu z panelu/env: `null` = bez progu (`''`, `off`), `undefined`
 * = nie da się odczytać.
 */
export function parseMinVersionStrict(raw: string): string | null | undefined {
  const value = raw.trim().toLowerCase();
  if (value === '' || value === 'off') return null;
  return VERSION.test(value) ? value : undefined;
}

/** Porównanie po segmentach liczbowych; brakujący segment = 0 (`1.0` = `1`). */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** Próg dla platformy — z nadpisaniem z panelu; zła wartość = bez progu. */
export function readMinVersion(
  platform: AppPlatform,
  env: NodeJS.ProcessEnv = effectiveProcessEnv(),
): string | null {
  return (
    parseMinVersionStrict(env[APP_MIN_VERSION_KEYS[platform]] ?? '') ?? null
  );
}

export interface AppVersionStatus {
  platform: AppPlatform;
  /** Najniższa wersja, która może działać; `null` = bez progu. */
  minVersion: string | null;
  /**
   * `true` = ta wersja jest za stara i aplikacja ma pokazać ekran
   * „Zaktualizuj”. Bez (poprawnej) wersji w pytaniu zawsze `false`.
   */
  updateRequired: boolean;
  storeUrl: string;
}

export function appVersionStatus(
  platform: AppPlatform,
  version: string | undefined,
  env?: NodeJS.ProcessEnv,
): AppVersionStatus {
  const minVersion = readMinVersion(platform, env);
  const current = version?.trim();
  const updateRequired =
    minVersion !== null &&
    current !== undefined &&
    VERSION.test(current) &&
    compareVersions(current, minVersion) < 0;
  return {
    platform,
    minVersion,
    updateRequired,
    storeUrl: APP_STORE_URLS[platform],
  };
}
