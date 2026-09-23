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

/**
 * `TransactionIdNotFoundError` z App Store Server API.
 *
 * Ten jeden kod znaczy „nie znam tego identyfikatora POD TYM ADRESEM" i jest
 * jedynym, po którym Apple każe powtórzyć pytanie pod adresem sandboxa.
 */
const APPLE_TRANSACTION_ID_NOT_FOUND = 4040010;

/**
 * Identyfikator do sprawdzenia samego klucza. Apple go nie zna i nie pozna —
 * chodzi wyłącznie o to, czy odpowie 404 (token dobry), czy 401 (token zły).
 */
const PROBE_TRANSACTION_ID = '0';

/**
 * Odpowiedź z informacją, SKĄD przyszła — produkcja czy sandbox.
 */
type Lookup = { response: Response; fromSandbox: boolean };

/**
 * Powód odmowy prosto od Apple.
 *
 * Ciało odpowiedzi błędu było dotąd wyrzucane bez czytania, więc w logu
 * zostawał sam kod HTTP. Apple w każdym zgłoszeniu pyta o `errorCode` — bez
 * niego rozmowa ze wsparciem Apple zaczyna się od „nie wiem".
 */
async function readAppleError(
  response: Response,
): Promise<{ code: number | null; opis: string }> {
  try {
    const body = (await response.clone().json()) as {
      errorCode?: number;
      errorMessage?: string;
    };
    if (typeof body.errorCode === 'number') {
      return {
        code: body.errorCode,
        opis: `errorCode ${body.errorCode}: ${body.errorMessage ?? 'bez opisu'}`,
      };
    }
  } catch {
    // Odpowiedź bez JSON-a (bramka, proxy) — zostaje sam status.
  }
  return { code: null, opis: `bez errorCode, HTTP ${response.status}` };
}

export type AppleSubscriptionState = {
  originalTransactionId: string;
  /** Surowy status Apple (1–5). */
  status: number;
  transaction: AppleTransactionInfo;
  renewal: AppleRenewalInfo | null;
};

/**
 * Nasz klucz `.p8` jest nie do użycia — to NIE jest awaria Apple.
 *
 * Rozdzielone, bo skutek jest inny: awaria Apple mija sama, a zły klucz nie
 * minie nigdy i musi zgasić paywall. Wcześniej jedno i drugie wychodziło jako
 * „App Store chwilowo nie odpowiada", więc klient płacił, nie dostawał dostępu
 * i widział komunikat sugerujący, że to u Apple.
 */
export class AppStoreKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppStoreKeyError';
  }
}

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
    let key;
    try {
      key = createPrivateKey(env.privateKey);
    } catch (error) {
      // Klucz wklejony do Railway z urwanym nagłówkiem albo z przełamanymi
      // liniami rzuca TUTAJ, zanim poleci jakiekolwiek żądanie. Bez tego
      // rozróżnienia wyjątek wpadał do `catch` wokół `fetch` i meldował się
      // jako „App Store nie odpowiada" — mimo że Apple nikt nie pytał.
      throw new AppStoreKeyError(
        `Nie da się odczytać APPLE_BILLING_PRIVATE_KEY: ${String(error)}`,
      );
    }
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

    // NAJPIERW PRODUKCJA, PO 4040010 SANDBOX — tak każe Apple i nie ma od tego
    // ucieczki. Recenzent App Store testuje PRODUKCYJNY build kontem
    // sandboxowym; tak samo każdy tester z TestFlighta. Bez tego zejścia
    // recenzent klika „Kup", płaci w sandboxie i dostaje odmowę — czyli
    // odrzucenie aplikacji, zanim pojawi się pierwszy prawdziwy klient.
    const first = await this.lookup(env, originalTransactionId);
    let response = first.response;
    if (
      !first.fromSandbox &&
      response.status === 404 &&
      env.sandboxApiBaseUrl !== env.serverApiBaseUrl
    ) {
      const powod = await readAppleError(response);
      if (powod.code === APPLE_TRANSACTION_ID_NOT_FOUND) {
        this.logger.log(
          `Apple nie zna ${originalTransactionId} na produkcji — pytam sandbox.`,
        );
        response = await this.get(
          env,
          env.sandboxApiBaseUrl,
          originalTransactionId,
        );
      }
    }

    if (response.status === 404) {
      const powod = await readAppleError(response);
      // ŚWIEŻO KUPIONA TRANSAKCJA BYWA NIEWIDOCZNA PRZEZ KILKA MINUT.
      //
      // Podpis pod nią sprawdziliśmy już do przypiętego korzenia Apple, więc
      // ona ISTNIEJE — 404 znaczy tu „jeszcze nie u mnie", nie „nie ma czegoś
      // takiego". Odesłanie tego jako trwałej odmowy kosztowało dokładnie
      // pierwszy zakup każdego klienta: telefon uznawał odmowę za ostateczną,
      // domykał transakcję i pieniądze przepadały bez żadnej ścieżki odzysku.
      // Dlatego to jest awaria chwilowa, którą wolno ponowić.
      throw new AppStoreUnavailableError(
        `App Store jeszcze nie widzi transakcji ${originalTransactionId} (${powod.opis}).`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      // To NIE mija samo: zły klucz, zły issuer albo klucz cofnięty w App Store
      // Connect. Musi zgasić paywall, a nie udawać awarii Apple.
      throw new AppStoreKeyError(
        `App Store odrzuciło nasz token (${response.status}). Sprawdź, czy klucz pochodzi z Users and Access → Integrations → Keys → In-App Purchase.`,
      );
    }
    if (!response.ok) {
      const powod = await readAppleError(response);
      throw new AppStoreUnavailableError(
        `App Store Server API odpowiedziało ${response.status} (${powod.opis}).`,
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

  /**
   * Czy Apple w ogóle nas uwierzytelnia.
   *
   * Pytamy o identyfikator, którego Apple na pewno nie zna, i patrzymy WYŁĄCZNIE
   * na kod odpowiedzi. 404 jest tu SUKCESEM: znaczy „przyjąłem twój token,
   * tylko nie znam tej transakcji". 401 albo 403 znaczy „twój klucz jest zły" —
   * i to jest jedyna rzecz, której nie wolno odkryć dopiero od pierwszego
   * płacącego klienta.
   */
  async verifyCredentials(): Promise<
    | { stan: 'ok'; szczegol: string }
    | { stan: 'klucz'; szczegol: string }
    | { stan: 'nieznany'; szczegol: string }
  > {
    const env = readBillingEnv();
    if (!env.enabled) {
      return { stan: 'nieznany', szczegol: 'Płatności są wyłączone.' };
    }
    let response: Response;
    let fromSandbox: boolean;
    try {
      ({ response, fromSandbox } = await this.lookup(
        env,
        PROBE_TRANSACTION_ID,
      ));
    } catch (error) {
      if (error instanceof AppStoreKeyError) {
        return { stan: 'klucz', szczegol: error.message };
      }
      return { stan: 'nieznany', szczegol: String(error) };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        stan: 'klucz',
        szczegol: `App Store odrzuciło token (${response.status}). Klucz musi pochodzić z Users and Access → Integrations → Keys → In-App Purchase, a APPLE_ISSUER_ID z tej samej strony.`,
      };
    }
    if (response.status === 404 || response.ok) {
      return {
        stan: 'ok',
        szczegol: fromSandbox
          ? `Produkcja Apple odmawia (401) — tak jest do pierwszego wydania aplikacji w App Store. Sandbox przyjął ten sam token (HTTP ${response.status}), więc klucz jest dobry.`
          : `Apple przyjęło nasz token (HTTP ${response.status}).`,
      };
    }
    const powod = await readAppleError(response);
    return {
      stan: 'nieznany',
      szczegol: `App Store odpowiedziało ${response.status} (${powod.opis}).`,
    };
  }

  /**
   * Pierwsze pytanie o transakcję: produkcja, a po 401 — sandbox.
   *
   * APLIKACJA PRZED PIERWSZYM WYDANIEM. Produkcyjne App Store Server API
   * odmawia (401) KAŻDEGO żądania aplikacji, która nie ma jeszcze wydania
   * w App Store — także z dobrym kluczem („Until you have a release in
   * production, access to the production APIs is not allowed”, Apple
   * Developer Forums). Zejście po 404 (`TransactionIdNotFound`) nigdy wtedy
   * nie zachodzi, bo 401 przychodzi pierwsze: recenzent App Store kupuje
   * w sandboxie i dostaje odmowę, a sprawdzenie przy starcie gasiło
   * sprzedaż, choć klucz był dobry (prod, 23.09.2026).
   *
   * Schodzimy TYLKO przy jawnej zgodzie na sandbox (`acceptSandbox`) i tylko
   * po 401. Jeśli sandbox też odmawia, zwracamy odpowiedź produkcji — wtedy
   * klucz jest naprawdę zły. Po wydaniu produkcja przestaje odmawiać i ta
   * gałąź sama wygasa.
   */
  private async lookup(
    env: BillingEnv,
    originalTransactionId: string,
  ): Promise<Lookup> {
    const response = await this.get(
      env,
      env.serverApiBaseUrl,
      originalTransactionId,
    );
    if (
      response.status !== 401 ||
      !env.acceptSandbox ||
      env.sandboxApiBaseUrl === env.serverApiBaseUrl
    ) {
      return { response, fromSandbox: false };
    }
    const sandbox = await this.get(
      env,
      env.sandboxApiBaseUrl,
      originalTransactionId,
    );
    if (sandbox.status === 401 || sandbox.status === 403) {
      return { response, fromSandbox: false };
    }
    this.logger.warn(
      'Produkcja App Store odmawia (401), sandbox przyjmuje — aplikacja bez wydania w App Store?',
    );
    return { response: sandbox, fromSandbox: true };
  }

  /** Jedno żądanie pod wskazany adres. Awaria sieci = awaria chwilowa. */
  private async get(
    env: BillingEnv,
    baseUrl: string,
    originalTransactionId: string,
  ): Promise<Response> {
    const url = `${baseUrl}/inApps/v1/subscriptions/${encodeURIComponent(originalTransactionId)}`;
    try {
      return await fetch(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${await this.clientToken(env)}`,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(env.serverApiTimeoutMs),
      });
    } catch (error) {
      if (error instanceof AppStoreKeyError) throw error;
      throw new AppStoreUnavailableError(
        `App Store Server API nie odpowiada: ${String(error)}`,
      );
    }
  }
}
