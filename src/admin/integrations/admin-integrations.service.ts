import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/app-exception';
import type {
  AppStoreState,
  OpsData,
  OpsRange,
  RailwayLogs,
  RailwayServiceState,
} from '../contract';
import { fetchAppStore } from './app-store-connect.client';
import { IntegrationCache, IntegrationError } from './integration-fetch';
import {
  missingAsc,
  missingSentry,
  readAscEnv,
  readRailwayToken,
  readSentryEnv,
} from './integrations-env';
import {
  fetchRailwayLogs,
  fetchRailwayService,
} from './railway-service.client';
import { fetchRailway } from './railway.client';
import { fetchSentry } from './sentry.client';

/** Panel odświeża „System” co minutę; ASC zmienia się rzadko, a limit ma niski. */
const OPS_TTL_MS = 60_000;
const ASC_TTL_MS = 5 * 60_000;
/** Strona usługi odświeża się co minutę, zmiana okresu to nowy klucz. */
const SERVICE_TTL_MS = 30_000;

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

  service(id: string, range: OpsRange): Promise<RailwayServiceState> {
    const token = readRailwayToken();
    if (!token) {
      return Promise.resolve({
        status: 'off',
        missing: ['ADMIN_RAILWAY_TOKEN'],
      });
    }
    return this.cache.get(`railway:${id}:${range}`, SERVICE_TTL_MS, () =>
      fetchRailwayService(token, id, range),
    );
  }

  /**
   * Logi bez pamięci podręcznej — to odczyt „na teraz”. Błąd dostawcy idzie
   * jako 503 z komunikatem: tu nie ma stanu `off/error`, bo ekran pyta
   * o logi dopiero, gdy integracja już działa.
   */
  logs(
    id: string,
    options: {
      deploymentId?: string;
      kind: 'deploy' | 'build';
      filter?: string;
    },
  ): Promise<RailwayLogs> {
    const token = readRailwayToken();
    if (!token) {
      throw new AppException(
        'SERVICE_UNAVAILABLE',
        'Railway nie jest podłączony (ADMIN_RAILWAY_TOKEN).',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return fetchRailwayLogs(token, id, options).catch((error: unknown) => {
      throw new AppException(
        'SERVICE_UNAVAILABLE',
        error instanceof IntegrationError
          ? error.message
          : 'Railway nie oddał logów.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    });
  }
}
