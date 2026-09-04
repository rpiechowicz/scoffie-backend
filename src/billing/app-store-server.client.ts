import { Injectable, Logger } from '@nestjs/common';
import { createPrivateKey } from 'node:crypto';
import { SignJWT } from 'jose';
import {
  AppleJwsError,
  verifyRenewalInfo,
  verifyTransaction,
  type AppleRenewalInfo,
  type AppleTransactionInfo,
} from './apple-jws.verifier';
import { readBillingEnv, type BillingEnv } from './billing-env';

/**
 * Klient App Store Server API — nasze jedyne ŹRÓDŁO PRAWDY o subskrypcji.
 *
 * DLACZEGO NIE WYSTARCZY TO, CO PRZYSYŁA TELEFON. Transakcja z telefonu jest
 * podpisana przez Apple i weryfikowalna, ale mówi tylko o JEDNEJ chwili —
 * o zakupie. Nie wie o zwrocie pieniędzy sprzed godziny, o anulowaniu, o
 * zmianie planu ani o tym, że ten sam paragon zgłasza właśnie drugie konto.
 * Dlatego to, co przyszło od telefonu, traktujemy WYŁĄCZNIE jako WSKAZÓWKĘ
 * („sprawdź tę subskrypcję"), a stan bierzemy stąd.
 *
 * Statusy Apple (`status` w `lastTransactions`):
 *   1 — aktywna
 *   2 — wygasła
 *   3 — ponawianie płatności BEZ łaski (dostęp już się skończył)
 *   4 — ponawianie płatności W ŁASCE (dostęp trwa)
 *   5 — cofnięta (zwrot pieniędzy albo decyzja Apple)
 */

export type AppleSubscriptionState = {
  originalTransactionId: string;
  /** Surowy status Apple (1–5). */
  status: number;
  transaction: AppleTransactionInfo;
  renewal: AppleRenewalInfo | null;
};

export class AppStoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppStoreUnavailableError';
  }
}

/** Subskrypcji o tym identyfikatorze Apple w ogóle nie zna. */
export class AppStoreNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppStoreNotFoundError';
  }
}

@Injectable()
export class AppStoreServerClient {
  private readonly logger = new Logger(AppStoreServerClient.name);

  /**
   * Token uwierzytelniający NAS wobec Apple (ES256 kluczem `.p8`).
   *
   * Krótki czas życia (5 minut) i tworzony na każde żądanie: Apple dopuszcza
   * godzinę, ale token trzymany w pamięci przeżywa rotację klucza i wtedy
   * uzgadnianie umiera po cichu — z 401 zamiast z czytelnym błędem.
   */
  private async clientToken(env: BillingEnv): Promise<string> {
    const key = createPrivateKey(env.privateKey);
    return new SignJWT({ bid: env.bundleId })
      .setProtectedHeader({ alg: 'ES256', kid: env.keyId, typ: 'JWT' })
      .setIssuer(env.issuerId)
      .setAudience('appstoreconnect-v1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key);
  }

  /**
   * Stan subskrypcji według Apple.
   *
   * Rozróżnia trzy sytuacje, bo każda ma inny skutek dla klienta:
   *   • dane → uzgadniamy stan;
   *   • 404 → Apple nie zna tej transakcji (podrobiona albo z sandboxa);
   *   • awaria/timeout → `AppStoreUnavailableError`, czyli NIE RUSZAMY stanu.
   *     Awaria po stronie Apple nie ma prawa odciąć płacących klientów —
   *     lepiej dać dzień PRO za darmo niż odebrać opłacone.
   */
  async subscriptionState(
    originalTransactionId: string,
    now: Date = new Date(),
  ): Promise<AppleSubscriptionState> {
    const env = readBillingEnv();
    if (!env.enabled) {
      throw new AppStoreUnavailableError('Płatności nie są skonfigurowane.');
    }
    const url = `${env.serverApiBaseUrl}/inApps/v1/subscriptions/${encodeURIComponent(originalTransactionId)}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${await this.clientToken(env)}`,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(env.serverApiTimeoutMs),
      });
    } catch (error) {
      throw new AppStoreUnavailableError(
        `App Store Server API nie odpowiada: ${String(error)}`,
      );
    }

    if (response.status === 404) {
      throw new AppStoreNotFoundError(
        'App Store nie zna tej transakcji w tym środowisku.',
      );
    }
    if (!response.ok) {
      // 401 to najczęściej zły albo cofnięty klucz `.p8` — musi być głośne,
      // bo inaczej uzgadnianie umiera po cichu i nikt się nie dowiaduje.
      throw new AppStoreUnavailableError(
        `App Store Server API odpowiedziało ${response.status}.`,
      );
    }

    const body = (await response.json()) as {
      data?: {
        lastTransactions?: {
          originalTransactionId?: string;
          status?: number;
          signedTransactionInfo?: string;
          signedRenewalInfo?: string;
        }[];
      }[];
    };

    const entry = body.data
      ?.flatMap((group) => group.lastTransactions ?? [])
      .find((item) => item.originalTransactionId === originalTransactionId);
    if (!entry?.signedTransactionInfo) {
      throw new AppStoreNotFoundError(
        'Odpowiedź App Store nie zawiera tej subskrypcji.',
      );
    }

    // Odpowiedź Apple też jest podpisana i też jej nie ufamy na słowo —
    // przechodzi przez tę samą bramkę, co transakcja z telefonu.
    const transaction = verifyTransaction(
      entry.signedTransactionInfo,
      env,
      now,
    );
    let renewal: AppleRenewalInfo | null = null;
    if (entry.signedRenewalInfo) {
      try {
        renewal = verifyRenewalInfo(entry.signedRenewalInfo, now);
      } catch (error) {
        // Brak informacji o odnowieniu nie unieważnia transakcji — tracimy
        // tylko datę końca łaski płatniczej.
        if (!(error instanceof AppleJwsError)) throw error;
        this.logger.warn(
          `Nie udało się odczytać signedRenewalInfo: ${error.message}`,
        );
      }
    }

    return {
      originalTransactionId,
      status: entry.status ?? 0,
      transaction,
      renewal,
    };
  }
}
