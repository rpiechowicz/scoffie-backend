import { Injectable } from '@nestjs/common';
import type { AppStoreState, OpsData } from '../contract';
import { fetchAppStore } from './app-store-connect.client';
import { IntegrationCache } from './integration-fetch';
import {
  missingAsc,
  missingSentry,
  readAscEnv,
  readRailwayToken,
  readSentryEnv,
} from './integrations-env';
import { fetchRailway } from './railway.client';
import { fetchSentry } from './sentry.client';

/** Panel odświeża „System” co minutę; ASC zmienia się rzadko, a limit ma niski. */
const OPS_TTL_MS = 60_000;
const ASC_TTL_MS = 5 * 60_000;

/**
 * Stabilność (Sentry + Railway) i App Store Connect (ROADMAPA §5.9) —
 * wyłącznie odczyt. Każda integracja osobno: brak klucza albo awaria jednej
 * nie zasłania drugiej.
 */
@Injectable()
export class AdminIntegrationsService {
  private readonly cache = new IntegrationCache();

  async ops(): Promise<OpsData> {
    const sentryEnv = readSentryEnv();
    const railwayToken = readRailwayToken();
    const missing = missingSentry(sentryEnv);
    const [sentry, railway] = await Promise.all([
      missing.length > 0
        ? { status: 'off' as const, missing }
        : this.cache.get('sentry', OPS_TTL_MS, () => fetchSentry(sentryEnv)),
      railwayToken
        ? this.cache.get('railway', OPS_TTL_MS, () =>
            fetchRailway(railwayToken),
          )
        : { status: 'off' as const, missing: ['ADMIN_RAILWAY_TOKEN'] },
    ]);
    return { sentry, railway };
  }

  appStore(): Promise<AppStoreState> {
    const env = readAscEnv();
    const missing = missingAsc(env);
    if (missing.length > 0) return Promise.resolve({ status: 'off', missing });
    return this.cache.get('asc', ASC_TTL_MS, () => fetchAppStore(env));
  }
}
