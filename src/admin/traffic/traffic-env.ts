import type { CloudflareEnv } from './cloudflare-traffic.client';

/**
 * Token Cloudflare do ruchu (ROADMAPA §5.10) — czytany per żądanie, jak
 * pozostałe integracje (`integrations-env.ts`). Token API z uprawnieniami
 * Zone → Analytics:Read i Zone:Read, zawężony do strefy scoffie.app.
 * Brak którejkolwiek zmiennej = integracja `off`.
 */
export function readCloudflareEnv(
  env: NodeJS.ProcessEnv = process.env,
): CloudflareEnv {
  return {
    token: (env.ADMIN_CLOUDFLARE_TOKEN ?? '').trim(),
    zoneId: (env.ADMIN_CLOUDFLARE_ZONE_ID ?? '').trim(),
  };
}

export function missingCloudflare(env: CloudflareEnv): string[] {
  return [
    ...(env.token ? [] : ['ADMIN_CLOUDFLARE_TOKEN']),
    ...(env.zoneId ? [] : ['ADMIN_CLOUDFLARE_ZONE_ID']),
  ];
}
