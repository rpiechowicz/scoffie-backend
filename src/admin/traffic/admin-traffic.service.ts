import { Injectable } from '@nestjs/common';
import type { TrafficState } from '../contract';
import { IntegrationCache } from '../integrations/integration-fetch';
import { fetchTraffic } from './cloudflare-traffic.client';
import { missingCloudflare, readCloudflareEnv } from './traffic-env';

/** Dane dzienne Cloudflare zmieniają się powoli, a GraphQL ma limity zapytań. */
export const TRAFFIC_TTL_MS = 10 * 60_000;

/** Ekran „Ruch” — strefa scoffie.app z Cloudflare, wyłącznie odczyt. */
@Injectable()
export class AdminTrafficService {
  private readonly cache = new IntegrationCache();

  traffic(fetchImpl: typeof fetch = globalThis.fetch): Promise<TrafficState> {
    const env = readCloudflareEnv();
    const missing = missingCloudflare(env);
    if (missing.length > 0) return Promise.resolve({ status: 'off', missing });
    return this.cache.get(`traffic:${env.zoneId}`, TRAFFIC_TTL_MS, () =>
      fetchTraffic(env, new Date(), fetchImpl),
    );
  }
}
