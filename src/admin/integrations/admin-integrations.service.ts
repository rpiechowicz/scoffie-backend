import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/app-exception';
import type {
  AscReviewResponse,
  AppStoreState,
  OpsData,
  OpsRange,
  RailwayLogs,
  RailwayServiceState,
} from '../contract';
import {
  AdminAuditService,
  type AdminActor,
} from '../audit/admin-audit.service';
import {
  AscWriteError,
  deleteReviewResponse,
  fetchAppStore,
  respondToReview,
} from './app-store-connect.client';
import {
  DeployTrackerService,
  deployInProgress,
} from './deploy-tracker.service';
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

  constructor(
    private readonly audit: AdminAuditService,
    private readonly deploys: DeployTrackerService,
  ) {
    // Stan wdrożeń zmienił się (webhook, śledzenie budowy) — następny odczyt
    // „System” i stron usług idzie po świeże dane, a nie z pamięci na minutę.
    this.deploys.onChange(() => {
      this.cache.invalidate('railway');
      this.cache.invalidatePrefix('railway:');
    });
  }

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
    // Ekran widzi budowę w toku — śledzimy ją, póki się nie skończy.
    if (
      railway.status === 'ok' &&
      railway.data.services.some((s) => deployInProgress(s.deploys[0]?.status))
    ) {
      this.deploys.poke();
    }
    return { sentry, railway };
  }

  appStore(): Promise<AppStoreState> {
    const env = readAscEnv();
    const missing = missingAsc(env);
    if (missing.length > 0) return Promise.resolve({ status: 'off', missing });
    return this.cache.get('asc', ASC_TTL_MS, () => fetchAppStore(env));
  }

  /**
   * Odpowiedź na recenzję (utworzenie albo zastąpienie). W audycie tylko
   * długość — treść recenzji i odpowiedzi zostaje w App Store Connect.
   */
  respondToReview(
    actor: AdminActor,
    reviewId: string,
    body: string,
  ): Promise<AscReviewResponse> {
    const env = this.ascEnvForWrite();
    return this.audit.run(
      actor,
      {
        action: 'appstore.review.respond',
        targetType: 'AscReview',
        targetId: reviewId,
        details: { length: body.length },
      },
      () => this.ascWrite(() => respondToReview(env, reviewId, body)),
      (response) => ({ responseId: response.id, state: response.state }),
    );
  }

  async deleteReviewResponse(
    actor: AdminActor,
    reviewId: string,
  ): Promise<void> {
    const env = this.ascEnvForWrite();
    await this.audit.run(
      actor,
      {
        action: 'appstore.review.response.delete',
        targetType: 'AscReview',
        targetId: reviewId,
      },
      () => this.ascWrite(() => deleteReviewResponse(env, reviewId)),
    );
  }

  private ascEnvForWrite() {
    const env = readAscEnv();
    if (missingAsc(env).length > 0) {
      throw ascRefusal(
        'SERVICE_UNAVAILABLE',
        'App Store Connect nie jest podłączony (ADMIN_ASC_*).',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return env;
  }

  /**
   * Zapis w ASC z czytelną odmową zamiast 500 (komunikat także w `details`,
   * bo panel pokazuje je wprost). Po zapisie (także nieudanym — stan u Apple
   * mógł się zmienić) czyścimy pamięć odczytu.
   */
  private async ascWrite<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (error instanceof IntegrationError) {
        throw ascRefusal(
          'SERVICE_UNAVAILABLE',
          error.message,
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      if (!(error instanceof AscWriteError)) throw error;
      if (error.status === 401 || error.status === 403) {
        throw ascRefusal(
          'SERVICE_UNAVAILABLE',
          'Klucz ASC bez prawa odpowiadania na recenzje — zmień jego rolę na Customer Support (albo App Manager / Admin).',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      if (error.status === 404) {
        throw ascRefusal('NOT_FOUND', error.message, HttpStatus.NOT_FOUND);
      }
      if ([400, 409, 422].includes(error.status)) {
        throw ascRefusal(
          'VALIDATION_ERROR',
          error.message,
          HttpStatus.BAD_REQUEST,
        );
      }
      throw ascRefusal(
        'SERVICE_UNAVAILABLE',
        error.message,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    } finally {
      this.cache.invalidate('asc');
    }
  }

  async service(id: string, range: OpsRange): Promise<RailwayServiceState> {
    const token = readRailwayToken();
    if (!token) {
      return { status: 'off', missing: ['ADMIN_RAILWAY_TOKEN'] };
    }
    const state = await this.cache.get(
      `railway:${id}:${range}`,
      SERVICE_TTL_MS,
      () => fetchRailwayService(token, id, range),
    );
    if (
      state.status === 'ok' &&
      deployInProgress(state.data.deploys[0]?.status)
    ) {
      this.deploys.poke();
    }
    return state;
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

const ascRefusal = (
  code: 'SERVICE_UNAVAILABLE' | 'NOT_FOUND' | 'VALIDATION_ERROR',
  message: string,
  status: HttpStatus,
) => new AppException(code, message, status, [message]);
