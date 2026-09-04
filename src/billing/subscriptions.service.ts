import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import {
  identityHashEquals,
  purchaseIdentityHashForUser,
  subscriptionScopeId,
} from '../config/purchase-identity';
import { SUBSCRIPTION_PRODUCTS } from '../config/subscription-products';
import { subscriptionAlive } from '../config/subscription-lifetime';
import {
  AppStoreKeyError,
  AppStoreNotFoundError,
  AppStoreServerClient,
  AppStoreUnavailableError,
  type AppleSubscriptionState,
} from './app-store-server.client';
import {
  AppleJwsError,
  appleDate,
  verifyAppleJws,
  verifyRenewalInfo,
  verifyTransaction,
} from './apple-jws.verifier';
import { readBillingEnv } from './billing-env';

/**
 * Subskrypcje App Store: zgłoszenie zakupu z telefonu, powiadomienia serwera
 * Apple i uzgadnianie stanu.
 *
 * ZASADA NACZELNA: telefon niczego nie nadaje. Podpisana transakcja z telefonu
 * jest tylko WSKAZÓWKĄ „sprawdź tę subskrypcję"; stan zawsze pochodzi z App
 * Store Server API albo z podpisanego ładunku powiadomienia. Dzięki temu zwrot
 * pieniędzy sprzed godziny, anulowanie i podmiana planu docierają do nas nawet
 * wtedy, gdy telefon o nich nie wie (albo udaje, że nie wie).
 *
 * DRUGA ZASADA: subskrypcja nie ma nic wspólnego z gospodarstwem. Należy do
 * osoby (`identityHash`), a to, komu daje PRO, liczy `resolvePlan` z faktu
 * „ta osoba jest teraz domownikiem". Nie ma tu ani jednej linii, która by coś
 * przypinała albo odpinała — bo nie ma czego.
 */

/**
 * Bezpieczne czytanie pola z nieznanego ładunku.
 *
 * `String(cokolwiek)` na obiekcie daje „[object Object]" i taki napis wpadłby
 * do bazy jako typ powiadomienia albo identyfikator — dlatego wszystko, co nie
 * jest napisem ani liczbą, traktujemy jak brak wartości.
 */
function text(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

/**
 * Kody odmowy weryfikatora, które NIE ZMIENIĄ SIĘ przy ponowieniu.
 *
 * Podpis jest w porządku (inaczej nie doszlibyśmy do treści) — to sama treść
 * dyskwalifikuje zdarzenie: cudza aplikacja, obce środowisko, Chmura Rodzinna,
 * brak wymaganych pól. Ponawianie takiego zdarzenia to pętla bez końca.
 */
const PERMANENT_JWS_CODES = new Set([
  'WRONG_BUNDLE',
  'WRONG_ENVIRONMENT',
  'FAMILY_SHARED',
  'INCOMPLETE',
]);

/** Statusy z App Store Server API. */
const APPLE_STATUS = {
  ACTIVE: 1,
  EXPIRED: 2,
  BILLING_RETRY: 3,
  GRACE: 4,
  REVOKED: 5,
} as const;

export type SubscriptionSummary = {
  id: string;
  productId: string;
  productName: string | null;
  status: string;
  alive: boolean;
  expiresAt: string | null;
  graceExpiresAt: string | null;
  autoRenews: boolean | null;
  environment: string | null;
  messagesLimit: number | null;
  plansLimit: number | null;
  /** Powód ręcznego odebrania dostępu; `null` = bez blokady. */
  operatorHold: string | null;
};

type SubscriptionState = {
  status: 'ACTIVE' | 'GRACE' | 'EXPIRED' | 'REVOKED';
  productId: string;
  latestTransactionId: string;
  expiresAt: Date | null;
  graceExpiresAt: Date | null;
  revokedAt: Date | null;
  autoRenewStatus: boolean | null;
  autoRenewProductId: string | null;
  environment: string | null;
  ownershipType: string | null;
};

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appStore: AppStoreServerClient,
  ) {}

  // ────────────────────────────── ZAKUP ──────────────────────────────

  /**
   * Zgłoszenie zakupu z telefonu.
   *
   * Kolejność jest tu istotna i każdy krok odpowiada konkretnemu atakowi:
   * 1. Weryfikacja podpisu z łańcuchem do przypiętego korzenia — inaczej
   *    wystarczy własny certyfikat w nagłówku (albo StoreKit Configuration
   *    z Xcode, który podpisuje transakcje LOKALNIE).
   * 2. Pytanie do Apple o STAN — inaczej paragon sprzed roku, po zwrocie
   *    pieniędzy, dalej daje PRO.
   * 3. Sprawdzenie, czy ta sama transakcja nie należy już do kogoś innego —
   *    inaczej ten sam paragon podesłany z dwóch kont przejmuje subskrypcję.
   */
  async registerAppleTransaction(
    userId: string,
    signedTransaction: string,
    now: Date = new Date(),
  ): Promise<SubscriptionSummary> {
    const env = readBillingEnv();
    if (!env.enabled) {
      throw new AppException(
        'BILLING_DISABLED',
        'Zakupy są chwilowo niedostępne.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        appleSub: true,
        googleId: true,
        identityHash: true,
        authProvider: true,
      },
    });
    if (!user) {
      throw new AppException(
        'NOT_FOUND',
        'Nie znaleziono użytkownika.',
        HttpStatus.NOT_FOUND,
      );
    }
    const identityHash =
      user.identityHash ?? purchaseIdentityHashForUser(user) ?? null;
    if (!identityHash) {
      // Konto bez zewnętrznego identyfikatora nie ma jak nieść subskrypcji
      // przez skasowanie konta — a zakup bez tego śladu byłby zakupem, którego
      // nie da się przywrócić.
      throw new AppException(
        'BILLING_IDENTITY_MISSING',
        'To konto nie może kupić subskrypcji — zaloguj się przez Apple.',
        HttpStatus.CONFLICT,
      );
    }

    let pointer;
    try {
      pointer = verifyTransaction(signedTransaction, env, now);
    } catch (error) {
      if (error instanceof AppleJwsError) {
        this.logger.warn(
          `Odrzucona transakcja (${error.code}) od ${userId}: ${error.message}`,
        );
        // Trzy odmowy mają WŁASNE komunikaty, bo znaczą co innego dla człowieka
        // i co innego dla obsługi. Jeden komunikat „nie udało się potwierdzić"
        // na wszystko zamieniał świadomą decyzję (Chmura Rodzinna, sandbox na
        // produkcji) w wyglądającą na awarię — a recenzent App Store widziałby
        // wtedy paywall, który po prostu nie działa.
        if (error.code === 'FAMILY_SHARED') {
          throw new AppException(
            'BILLING_FAMILY_SHARING_UNSUPPORTED',
            'Ta subskrypcja jest udostępniona przez Chmurę Rodzinną. Żeby korzystać z asystenta, wybierz własny plan.',
            HttpStatus.CONFLICT,
          );
        }
        if (error.code === 'WRONG_ENVIRONMENT') {
          throw new AppException(
            'BILLING_ENVIRONMENT_MISMATCH',
            'Ten zakup pochodzi ze środowiska testowego App Store i nie daje dostępu w tej wersji aplikacji.',
            HttpStatus.CONFLICT,
          );
        }
        throw new AppException(
          'BILLING_TRANSACTION_INVALID',
          'Nie udało się potwierdzić tego zakupu w App Store.',
          HttpStatus.BAD_REQUEST,
          [`reason:${error.code}`],
        );
      }
      throw error;
    }

    // `appAccountToken` — UUID konta wkładany przez telefon w chwili zakupu.
    // Apple podpisuje go razem z transakcją, więc jest to JEDYNY dowód, kto
    // naprawdę klikał „Kup". Bez tego sprawdzenia podpisana transakcja, która
    // komuś wyciekła (log serwera pośredniczącego, przechwycone żądanie),
    // należy do tego, kto ZGŁOSI JĄ PIERWSZY — a `originalTransactionId` jest
    // unikalny, więc prawowity właściciel dostaje potem BILLING_TRANSACTION_TAKEN
    // i nie ma jak tego odkręcić bez obsługi.
    if (pointer.appAccountToken) {
      const claimed = pointer.appAccountToken.trim().toLowerCase();
      if (claimed !== user.id.toLowerCase()) {
        // ZNACZNIK NIE MOŻE ODBIERAĆ ZAKUPU WŁASNEMU WŁAŚCICIELOWI.
        //
        // `appAccountToken` zostaje przy transakcji na zawsze — z identyfikatorem
        // konta z CHWILI ZAKUPU. Kto skasował konto i zalogował się ponownie tym
        // samym Apple ID, ma nowy identyfikator, więc znacznik wskazuje na konto,
        // którego już nie ma. Bezwarunkowa odmowa łamała dokładnie ten przypadek,
        // dla którego powstał cały hasz tożsamości: „skasowałem konto, wróciłem,
        // chcę swoje opłacone PRO".
        //
        // Rozstrzyga więc TOŻSAMOŚĆ, nie identyfikator konta: jeśli ta subskrypcja
        // jest już zapisana na tym samym haszu, to jest ta sama osoba i wpuszczamy.
        // Jeśli wiersza nie ma albo należy do kogoś innego — znacznik zostaje
        // ostatnim słowem i blokuje przejęcie wyciekłego paragonu.
        const existing = await this.prisma.subscription.findUnique({
          where: { originalTransactionId: pointer.originalTransactionId },
          select: { identityHash: true },
        });
        if (!identityHashEquals(existing?.identityHash, identityHash)) {
          this.logger.error(
            `Transakcja ${pointer.originalTransactionId} zgłoszona przez ${userId}, a appAccountToken wskazuje na inne konto i tożsamość się nie zgadza.`,
          );
          throw new AppException(
            'BILLING_TRANSACTION_TAKEN',
            'Ten zakup należy do innego konta.',
            HttpStatus.CONFLICT,
          );
        }
        this.logger.log(
          `Transakcja ${pointer.originalTransactionId}: appAccountToken wskazuje na poprzednie konto tej samej osoby — wpuszczam po haszu tożsamości.`,
        );
      }
    }

    // Nieznany produkt NIE jest błędem klienta: nowy SKU wypuszczony w App
    // Store przed deployem serwera dostanie limity z env, a nie odmowę.
    if (!SUBSCRIPTION_PRODUCTS[pointer.productId]) {
      this.logger.warn(
        `Zakup nieznanego produktu ${pointer.productId} — limity z env.`,
      );
    }

    const state = await this.fetchState(pointer.originalTransactionId, now);
    const summary = await this.persist(
      identityHash,
      user.id,
      pointer.originalTransactionId,
      state,
      now,
    );
    // ŚLAD TOŻSAMOŚCI MUSI BYĆ W KOLUMNIE, NIE TYLKO POLICZONY. `resolvePlan`
    // szuka subskrypcji po haszach OBECNYCH domowników, a te bierze z
    // `User.identityHash`. Konto, które kupiło zanim kolumna została wypełniona,
    // miało subskrypcję w bazie i mimo to plan próbny — czyli dokładnie
    // „płacę i nie mam asystenta". Zapis jest warunkowy, więc nie nadpisuje
    // istniejącego śladu i nie przeszkadza równoległemu logowaniu.
    if (!user.identityHash) {
      await this.prisma.user
        .updateMany({
          where: { id: user.id, identityHash: null },
          data: { identityHash },
        })
        .catch((error: unknown) => {
          this.logger.warn(
            `Nie udało się dopisać identityHash dla ${user.id}: ${String(error)}`,
          );
        });
    }
    return summary;
  }

  /**
   * Stan z Apple, z jasnym podziałem błędów.
   *
   * Awaria Apple NIE może odciąć klienta, który właśnie zapłacił — ale nie może
   * też nadać PRO na słowo telefonu. Kompromis: przy awarii odmawiamy zapisu
   * z kodem, który telefon umie ponowić, i nie ruszamy istniejącego stanu.
   */
  private async fetchState(
    originalTransactionId: string,
    now: Date,
  ): Promise<AppleSubscriptionState> {
    try {
      return await this.appStore.subscriptionState(originalTransactionId, now);
    } catch (error) {
      if (error instanceof AppStoreNotFoundError) {
        // Zostaje po to, żeby stary klient dostał znany kod. Sam klient API
        // rzuca to dziś tylko wtedy, gdy odpowiedź Apple nie zawiera naszej
        // subskrypcji — świeżo kupiona transakcja idzie ścieżką „chwilowo".
        throw new AppException(
          'BILLING_TRANSACTION_UNKNOWN',
          'App Store jeszcze nie widzi tego zakupu. Spróbujemy ponownie za chwilę.',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      if (error instanceof AppStoreKeyError) {
        // NASZ błąd, nie awaria Apple. Zgłoszenie z telefonu i tak nie ma jak
        // przejść, ale w logu ma stać, co jest zepsute — inaczej wygląda to
        // jak awaria App Store i nikt nie sprawdza własnej konfiguracji.
        this.logger.error(
          `Klucz do App Store Server API nie działa: ${error.message}`,
        );
        throw new AppException(
          'BILLING_UPSTREAM_UNAVAILABLE',
          'App Store chwilowo nie odpowiada. Spróbuj za moment.',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      if (error instanceof AppStoreUnavailableError) {
        this.logger.error(`App Store niedostępne: ${error.message}`);
        throw new AppException(
          'BILLING_UPSTREAM_UNAVAILABLE',
          'App Store chwilowo nie odpowiada. Spróbuj za moment.',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      if (error instanceof AppleJwsError) {
        // Odmowa TREŚCIOWA w odpowiedzi samego Apple (obca aplikacja, obce
        // środowisko, Chmura Rodzinna). Bez tej gałęzi wychodziła z kontrolera
        // jako 500, a telefon traktował 500 jak awarię i wracał w kółko.
        this.logger.warn(
          `Odpowiedź App Store odrzucona treściowo (${error.code}): ${error.message}`,
        );
        throw new AppException(
          'BILLING_TRANSACTION_INVALID',
          'Nie udało się potwierdzić tego zakupu w App Store.',
          HttpStatus.BAD_REQUEST,
          [`reason:${error.code}`],
        );
      }
      throw error;
    }
  }

  /** Stan Apple → nasze pola. */
  private toState(source: AppleSubscriptionState): SubscriptionState {
    const { transaction, renewal, status } = source;
    const revokedAt = appleDate(transaction.revocationDate);
    const expiresAt = appleDate(transaction.expiresDate);
    const graceExpiresAt = appleDate(renewal?.gracePeriodExpiresDate);

    let mapped: SubscriptionState['status'];
    if (revokedAt || status === APPLE_STATUS.REVOKED) {
      mapped = 'REVOKED';
    } else if (status === APPLE_STATUS.ACTIVE) {
      mapped = 'ACTIVE';
    } else if (status === APPLE_STATUS.GRACE) {
      mapped = 'GRACE';
    } else if (
      status === APPLE_STATUS.EXPIRED ||
      status === APPLE_STATUS.BILLING_RETRY
    ) {
      // Status 3 (ponawianie płatności BEZ łaski) to brak dostępu — Apple
      // dopiero próbuje pobrać pieniądze, a opłacony okres już się skończył.
      mapped = 'EXPIRED';
    } else if (expiresAt && expiresAt.getTime() > Date.now()) {
      // Nieznany status: decyduje data, a nie zgadywanie. Nieznany typ
      // zmapowany „na wszelki wypadek" na EXPIRED odcinałby płacących.
      mapped = 'ACTIVE';
    } else {
      mapped = 'EXPIRED';
    }

    return {
      status: mapped,
      productId: transaction.productId,
      latestTransactionId: transaction.transactionId,
      expiresAt,
      graceExpiresAt,
      revokedAt,
      autoRenewStatus:
        renewal?.autoRenewStatus === undefined
          ? null
          : renewal.autoRenewStatus === 1,
      autoRenewProductId: renewal?.autoRenewProductId ?? null,
      environment: transaction.environment ?? null,
      ownershipType: transaction.inAppOwnershipType ?? null,
    };
  }

  /**
   * Zapis stanu subskrypcji.
   *
   * `originalTransactionId` jest unikalny, więc TU rozstrzyga się przejęcie
   * cudzej subskrypcji: jeśli wiersz istnieje i należy do innej tożsamości,
   * nie przepinamy go — to jest dokładnie ten atak („podeślij ten sam paragon
   * z drugiego konta"). Osoba, która skasowała konto i wróciła tym samym Apple
   * ID, ma ten sam `identityHash`, więc przechodzi bez żadnej akcji.
   */
  private async persist(
    identityHash: string,
    userId: string | null,
    originalTransactionId: string,
    source: AppleSubscriptionState,
    now: Date,
  ): Promise<SubscriptionSummary> {
    const state = this.toState(source);
    const existing = await this.prisma.subscription.findUnique({
      where: { originalTransactionId },
    });

    if (existing && !identityHashEquals(existing.identityHash, identityHash)) {
      this.logger.error(
        `Próba przypisania cudzej subskrypcji ${originalTransactionId} (użytkownik ${userId ?? '-'}).`,
      );
      throw new AppException(
        'BILLING_TRANSACTION_TAKEN',
        'Ten zakup jest już przypisany do innego konta.',
        HttpStatus.CONFLICT,
      );
    }

    const limits = this.limitsFor(state, existing, now);
    const data = {
      identityHash,
      purchaserUserId: userId,
      provider: 'APPLE' as const,
      productId: state.productId,
      originalTransactionId,
      latestTransactionId: state.latestTransactionId,
      status: state.status,
      expiresAt: state.expiresAt,
      graceExpiresAt: state.graceExpiresAt,
      revokedAt: state.revokedAt,
      autoRenewStatus: state.autoRenewStatus,
      autoRenewProductId: state.autoRenewProductId,
      environment: state.environment,
      ownershipType: state.ownershipType,
      messagesLimitSnapshot: limits.messages,
      plansLimitSnapshot: limits.plans,
      lastVerifiedAt: now,
      // Stan z App Store Server API jest świeższy niż KAŻDE powiadomienie
      // podpisane wcześniej. Bez przesunięcia tego znacznika zaległe zdarzenie
      // z kolejki potrafiło po uzgodnieniu cofnąć stan do tego, co Apple
      // mówiło godzinę temu — strażnik kolejności porównuje się właśnie z nim.
      lastNotificationAt: now,
    };

    const saved = existing
      ? await this.prisma.subscription.update({
          where: { id: existing.id },
          data,
        })
      : await this.prisma.subscription.create({ data });

    if (state.ownershipType === 'FAMILY_SHARED') {
      // Tu można trafić TYLKO przy jawnym `APPLE_ACCEPT_FAMILY_SHARED=true`
      // (bramka w `checkTransactionPayload` odrzuca resztę). Wtedy trzeba
      // wiedzieć, że jedna opłata zaczyna właśnie utrzymywać kolejną pełną pulę:
      // każdy członek rodziny ma własny `originalTransactionId`, więc własny
      // wiersz i własny `sub:<id>`.
      this.logger.warn(
        `Subskrypcja ${saved.id} przyszła jako FAMILY_SHARED — osobna pula na jednej opłacie (APPLE_ACCEPT_FAMILY_SHARED=true).`,
      );
    }

    return this.toSummary(saved, now);
  }

  /**
   * Migawka limitów.
   *
   * Nowy opłacony okres (późniejsza data końca) bierze limity BIEŻĄCEGO
   * produktu — tak działa zmiana planu w dół: obowiązuje od odnowienia, na
   * które klient się zgodził. W trakcie okresu limit może tylko rosnąć.
   */
  private limitsFor(
    state: SubscriptionState,
    existing: {
      expiresAt: Date | null;
      messagesLimitSnapshot: number | null;
      plansLimitSnapshot: number | null;
    } | null,
    _now: Date,
  ): { messages: number | null; plans: number | null } {
    const product = SUBSCRIPTION_PRODUCTS[state.productId];
    if (!product) {
      return {
        messages: existing?.messagesLimitSnapshot ?? null,
        plans: existing?.plansLimitSnapshot ?? null,
      };
    }
    const newPeriod =
      !existing?.expiresAt ||
      (state.expiresAt !== null &&
        state.expiresAt.getTime() > existing.expiresAt.getTime());
    if (newPeriod) {
      return {
        messages: product.messagesPerMonth,
        plans: product.plansPerMonth,
      };
    }
    return {
      messages: Math.max(
        product.messagesPerMonth,
        existing?.messagesLimitSnapshot ?? 0,
      ),
      plans: Math.max(product.plansPerMonth, existing?.plansLimitSnapshot ?? 0),
    };
  }

  // ───────────────────────── POWIADOMIENIA APPLE ─────────────────────────

  /**
   * App Store Server Notifications v2.
   *
   * Trzy rzeczy, których ta metoda celowo NIE robi:
   *
   * • Nie mapuje `notificationType` na stan. Typ służy wyłącznie do zapisu w
   *   dzienniku; stan bierze się z PODPISANYCH danych w ładunku. Dzięki temu
   *   nowy albo nieznany typ powiadomienia nigdy nikogo nie odetnie.
   * • Nie tworzy subskrypcji, której nie zna. Powiadomienie nie niesie
   *   tożsamości kupującego, więc wiersz zakłada dopiero zgłoszenie z telefonu.
   *   Zdarzenie leży zapisane i zostanie przetworzone, gdy wiersz powstanie.
   * • Nie odpowiada 200 przed trwałym zapisem — patrz kontroler.
   */
  async recordNotification(
    signedPayload: string,
    now: Date = new Date(),
  ): Promise<{ uuid: string; duplicate: boolean }> {
    const payload = verifyAppleJws(signedPayload, {
      now,
      rootPem: readBillingEnv().rootCaPem,
    }) as Record<string, unknown>;
    const uuid = text(payload.notificationUUID);
    if (!uuid) {
      throw new AppleJwsError(
        'INCOMPLETE',
        'Powiadomienie bez notificationUUID.',
      );
    }
    const data = (payload.data ?? {}) as Record<string, unknown>;
    const env = readBillingEnv();
    const bundleId = text(data.bundleId);
    if (bundleId && bundleId !== env.bundleId) {
      throw new AppleJwsError(
        'WRONG_BUNDLE',
        'Powiadomienie dotyczy innej aplikacji.',
      );
    }

    const existing = await this.prisma.appleNotification.findUnique({
      where: { notificationUuid: uuid },
      select: { processedAt: true },
    });
    if (existing?.processedAt) {
      // Apple ponawia do pięciu razy przez trzy doby. Drugie przetworzenie
      // tego samego zdarzenia potrafiłoby cofnąć nowszy stan.
      return { uuid, duplicate: true };
    }
    if (!existing) {
      await this.prisma.appleNotification.create({
        data: {
          notificationUuid: uuid,
          notificationType: text(payload.notificationType, 'UNKNOWN'),
          subtype: text(payload.subtype) || null,
          originalTransactionId: this.originalIdFrom(data, now),
          environment: text(data.environment) || null,
          signedPayload,
        },
      });
    }
    return { uuid, duplicate: false };
  }

  private originalIdFrom(
    data: Record<string, unknown>,
    now: Date,
  ): string | null {
    const signed = data.signedTransactionInfo;
    if (typeof signed !== 'string') return null;
    try {
      return verifyTransaction(signed, readBillingEnv(), now)
        .originalTransactionId;
    } catch {
      return null;
    }
  }

  /**
   * Przetworzenie zapisanego powiadomienia. Wołane zaraz po zapisie i ponownie
   * przez uzgadnianie, gdy za pierwszym razem się nie udało.
   */
  async processNotification(
    uuid: string,
    now: Date = new Date(),
  ): Promise<void> {
    const row = await this.prisma.appleNotification.findUnique({
      where: { notificationUuid: uuid },
    });
    if (!row || row.processedAt) return;

    await this.prisma.appleNotification.update({
      where: { notificationUuid: uuid },
      data: { attempts: { increment: 1 } },
    });

    try {
      const payload = verifyAppleJws(row.signedPayload, {
        now,
        rootPem: readBillingEnv().rootCaPem,
      }) as Record<string, unknown>;
      const data = (payload.data ?? {}) as Record<string, unknown>;
      const signedTransaction = data.signedTransactionInfo;
      if (typeof signedTransaction !== 'string') {
        // Powiadomienia bez transakcji (np. TEST) są poprawne i nic nie zmieniają.
        await this.markProcessed(uuid, now, null);
        return;
      }
      const env = readBillingEnv();
      let transaction;
      try {
        transaction = verifyTransaction(signedTransaction, env, now);
      } catch (error) {
        // ZDARZENIE, KTÓREGO NIGDY NIE PRZETWORZYMY, NIE MA WRACAĆ W KÓŁKO.
        // Zła aplikacja, złe środowisko, Chmura Rodzinna, brak wymaganych pól —
        // ponowienie za godzinę da dokładnie ten sam wynik. Wcześniej takie
        // powiadomienie leciało wyjątkiem, kontroler oddawał Apple 500, Apple
        // ponawiało pięć razy przez trzy doby i przestawało, a wiersz zostawał
        // na zawsze nieprzetworzony — bez jednego miejsca, w którym dałoby się
        // to zobaczyć. Teraz zamykamy je z powodem, a `GET /ops/billing/
        // notifications/failed` pokazuje takie przypadki obsłudze.
        if (
          error instanceof AppleJwsError &&
          PERMANENT_JWS_CODES.has(error.code)
        ) {
          this.logger.error(
            `Powiadomienie ${uuid} odrzucone trwale (${error.code}): ${error.message}`,
          );
          await this.markProcessed(
            uuid,
            now,
            `Odrzucone trwale: ${error.code}`,
          );
          return;
        }
        throw error;
      }
      const renewal =
        typeof data.signedRenewalInfo === 'string'
          ? verifyRenewalInfo(data.signedRenewalInfo, now, env.rootCaPem)
          : null;

      const existing = await this.prisma.subscription.findUnique({
        where: { originalTransactionId: transaction.originalTransactionId },
      });
      if (!existing) {
        // Nie znamy właściciela — zdarzenie zostaje w dzienniku i doczeka się
        // zgłoszenia z telefonu. Nie zgadujemy, komu nadać PRO.
        await this.markProcessed(uuid, now, 'Subskrypcja jeszcze nieznana.');
        return;
      }

      const signedDate = appleDate(
        typeof payload.signedDate === 'number' ? payload.signedDate : undefined,
      );
      if (
        signedDate &&
        existing.lastNotificationAt &&
        signedDate.getTime() < existing.lastNotificationAt.getTime()
      ) {
        // Powiadomienia potrafią przyjść nie po kolei po awarii u Apple.
        // Starsze zdarzenie nie ma prawa cofnąć nowszego stanu.
        await this.markProcessed(uuid, now, 'Zdarzenie starsze niż stan.');
        return;
      }

      // ZWROT PIENIĘDZY ZA JEDEN STARY MIESIĄC NIE MOŻE ZABIĆ ŻYWEJ UMOWY.
      // Apple potrafi zwrócić pieniądze za pojedynczy okres wstecz. Ładunek
      // niesie wtedy TAMTĄ transakcję: z `revocationDate` i z lipcową datą
      // końca. `toState` daje z tego REVOKED, a `revokedAt` wygrywa ze
      // wszystkim — więc klient płacący od maja tracił dostęp mimo opłaconego
      // września, a strażnik kolejności tego nie łapał, bo `signedDate` samego
      // powiadomienia jest dzisiejsze. Rozstrzyga App Store Server API: ono zna
      // stan CAŁEJ subskrypcji, a nie jednej transakcji.
      const payloadExpires = appleDate(transaction.expiresDate);
      const staleTransaction =
        transaction.transactionId !== existing.latestTransactionId &&
        payloadExpires !== null &&
        existing.expiresAt !== null &&
        payloadExpires.getTime() < existing.expiresAt.getTime();
      if (staleTransaction) {
        this.logger.warn(
          `Powiadomienie ${uuid} dotyczy starszej transakcji subskrypcji ${existing.id} — pytamy Apple o stan całości.`,
        );
        const reconciled = await this.reconcile(existing.id, now);
        await this.markProcessed(
          uuid,
          now,
          reconciled
            ? 'Starsza transakcja — stan wzięty z App Store Server API.'
            : 'Starsza transakcja — App Store niedostępne, stan bez zmian.',
        );
        return;
      }

      const state = this.toState({
        originalTransactionId: transaction.originalTransactionId,
        status:
          typeof data.status === 'number' ? data.status : APPLE_STATUS.ACTIVE,
        transaction,
        renewal,
      });
      const limits = this.limitsFor(state, existing, now);
      // SPRAWDŹ-I-USTAW, NIE CZYTAJ-POTEM-PISZ. Między odczytem `existing`
      // a zapisem mieści się całe uzgodnienie i całe drugie powiadomienie —
      // Apple potrafi wysłać DID_RENEW i DID_CHANGE_RENEWAL_STATUS w tej samej
      // sekundzie, a Railway obsługuje je równolegle. Bez warunku w `where`
      // starsze zdarzenie po prostu nadpisywało nowszy stan, mimo że strażnik
      // kolejności wyżej „przepuścił" oba. `updateMany` z warunkiem na
      // `lastNotificationAt` przegrywa cicho i zostawia świeższy stan.
      const stamp = signedDate ?? now;
      const written = await this.prisma.subscription.updateMany({
        where: {
          id: existing.id,
          OR: [
            { lastNotificationAt: null },
            { lastNotificationAt: { lte: stamp } },
          ],
        },
        data: {
          productId: state.productId,
          latestTransactionId: state.latestTransactionId,
          status: state.status,
          expiresAt: state.expiresAt,
          graceExpiresAt: state.graceExpiresAt,
          revokedAt: state.revokedAt,
          autoRenewStatus: state.autoRenewStatus,
          autoRenewProductId: state.autoRenewProductId,
          environment: state.environment,
          ownershipType: state.ownershipType,
          messagesLimitSnapshot: limits.messages,
          plansLimitSnapshot: limits.plans,
          lastNotificationAt: stamp,
          lastNotificationType: text(payload.notificationType, 'UNKNOWN'),
          lastVerifiedAt: now,
        },
      });
      await this.markProcessed(
        uuid,
        now,
        written.count === 1 ? null : 'Wyprzedzone przez świeższy stan.',
      );
    } catch (error) {
      await this.prisma.appleNotification.update({
        where: { notificationUuid: uuid },
        data: { error: String(error).slice(0, 500) },
      });
      throw error;
    }
  }

  private async markProcessed(
    uuid: string,
    now: Date,
    note: string | null,
  ): Promise<void> {
    await this.prisma.appleNotification.update({
      where: { notificationUuid: uuid },
      data: { processedAt: now, error: note },
    });
  }

  // ───────────────────────────── UZGADNIANIE ─────────────────────────────

  /**
   * Dociągnięcie stanu z Apple dla jednej subskrypcji.
   *
   * Potrzebne, bo powiadomienie da się zgubić na zawsze: Apple ponawia przez
   * trzy doby i przestaje. Bez uzgadniania jedno zgubione `DID_RENEW` znaczy
   * utratę PRO przez płacącego klienta aż do reklamacji.
   *
   * Awaria Apple NIE zmienia stanu — zwraca `false` i zostawia wszystko jak
   * było. Odcięcie płacących przy awarii cudzego serwisu byłoby gorsze niż
   * dzień PRO wydany za darmo.
   */
  async reconcile(subscriptionId: string, now = new Date()): Promise<boolean> {
    const sub = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
    });
    if (!sub?.originalTransactionId || sub.provider !== 'APPLE') return false;
    try {
      const state = await this.appStore.subscriptionState(
        sub.originalTransactionId,
        now,
      );
      await this.persist(
        sub.identityHash,
        sub.purchaserUserId,
        sub.originalTransactionId,
        state,
        now,
      );
      return true;
    } catch (error) {
      if (error instanceof AppStoreNotFoundError) {
        this.logger.error(
          `Apple nie zna subskrypcji ${subscriptionId} — wymaga ręcznego sprawdzenia.`,
        );
        // ZATRUTA PARTIA. Kolejka uzgadniania bierze 25 NAJDAWNIEJ sprawdzanych
        // wierszy. Wiersz, którego Apple nie zna, nie dostawał nowego znacznika,
        // więc zostawał najdawniejszy NA ZAWSZE i wracał w każdym przebiegu —
        // dwadzieścia pięć takich wierszy blokowało odświeżanie wszystkim
        // pozostałym, w tym płacącym klientom czekającym na zgubione DID_RENEW.
        // Znacznik przesuwamy MIMO niepowodzenia: to nie jest „uzgodnione",
        // tylko „sprawdzone i nie ma po co pytać znowu w tej godzinie".
        await this.prisma.subscription.updateMany({
          where: { id: subscriptionId },
          data: {
            lastVerifiedAt: now,
            lastNotificationType: 'APPLE_NOT_FOUND',
          },
        });
        return false;
      }
      if (error instanceof AppStoreUnavailableError) {
        this.logger.warn(`Uzgadnianie ${subscriptionId}: ${error.message}`);
        return false;
      }
      if (error instanceof AppStoreKeyError) {
        this.logger.error(
          `Uzgadnianie ${subscriptionId} bez klucza do Apple: ${error.message}`,
        );
        return false;
      }
      if (error instanceof AppleJwsError) {
        // Wiersz, którego ODPOWIEDŹ APPLE nie przechodzi przez bramkę treści
        // (np. FAMILY_SHARED zapisany, gdy przełącznik był włączony). Bez tej
        // gałęzi wyjątek wychodził z `reconcile`, a przebieg nie ma try wokół
        // pojedynczego wiersza — więc JEDEN taki wiersz wywracał całą partię,
        // co godzinę, na zawsze. Znacznik przesuwamy, żeby nie zatykał kolejki.
        this.logger.error(
          `Uzgadnianie ${subscriptionId}: odpowiedź Apple odrzucona treściowo (${error.code}).`,
        );
        await this.prisma.subscription.updateMany({
          where: { id: subscriptionId },
          data: {
            lastVerifiedAt: now,
            lastNotificationType: `APPLE_REJECTED_${error.code}`,
          },
        });
        return false;
      }
      throw error;
    }
  }

  /**
   * Subskrypcje wymagające odświeżenia: żywe (albo świeżo zmarłe) i długo
   * niesprawdzane. To jest siatka bezpieczeństwa pod zgubione powiadomienia.
   */
  async staleSubscriptionIds(
    limit = 50,
    now: Date = new Date(),
  ): Promise<string[]> {
    const env = readBillingEnv();
    const cutoff = new Date(
      now.getTime() - env.reconcileAfterHours * 3600 * 1000,
    );
    // ŚWIEŻO WYGASŁE TEŻ, JEŚLI APPLE DALEJ MA JE ODNAWIAĆ. Wiersz oznaczony
    // EXPIRED wypadał z uzgadniania na zawsze — a wpaść tam można przez jedno
    // zgubione DID_RENEW. Klient płacił dalej, my o tym nie wiedzieliśmy i
    // jedynym wyjściem było „Przywróć zakupy" albo reklamacja. Sześćdziesiąt
    // dni, bo tyle wystarczy na dwa nieudane okresy; starsze naprawdę są martwe.
    const expiredWindow = new Date(now.getTime() - 60 * 24 * 3600 * 1000);
    // KONIEC OPŁACONEGO OKRESU JEST PILNIEJSZY NIŻ „24 GODZINY OD OSTATNIEGO
    // SPRAWDZENIA". Odnowienie następuje w konkretnej minucie; jeśli akurat
    // wtedy zgubimy DID_RENEW, klient czekał na odświeżenie nawet dobę — bo
    // jedynym kryterium było `lastVerifiedAt`, a ono mogło być świeże.
    // Wiersz, któremu okres właśnie minął, wchodzi do partii NIEZALEŻNIE od
    // tego, kiedy go ostatnio pytaliśmy: przebieg chodzi co godzinę, więc
    // płacący klient czeka najwyżej godzinę zamiast doby.
    const justEnded: Prisma.SubscriptionWhereInput = {
      status: { in: ['ACTIVE', 'GRACE'] },
      expiresAt: { lt: now, gt: expiredWindow },
    };
    const rows = await this.prisma.subscription.findMany({
      where: {
        provider: 'APPLE',
        OR: [
          {
            OR: [{ lastVerifiedAt: null }, { lastVerifiedAt: { lt: cutoff } }],
            AND: [
              {
                OR: [
                  { status: { in: ['ACTIVE', 'GRACE'] } },
                  {
                    status: 'EXPIRED',
                    autoRenewStatus: true,
                    expiresAt: { gt: expiredWindow },
                  },
                  {
                    // Wiersz cofnięty RĘCZNIE, z którego obsługa zdjęła już
                    // blokadę. Bez tego pomyłkowe odebranie dostępu było nie
                    // do cofnięcia: `unhold` czyści blokadę, ale status
                    // REVOKED wypadał z kolejki na zawsze, więc nikt go nigdy
                    // nie odpytał ponownie.
                    status: 'REVOKED',
                    operatorHoldAt: null,
                    expiresAt: { gt: expiredWindow },
                  },
                ],
              },
            ],
          },
          justEnded,
        ],
      },
      orderBy: { lastVerifiedAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  /** Powiadomienia, których nie udało się przetworzyć — do ponowienia. */
  async unprocessedNotificationUuids(limit = 50): Promise<string[]> {
    const rows = await this.prisma.appleNotification.findMany({
      where: { processedAt: null, attempts: { lt: 10 } },
      orderBy: { receivedAt: 'asc' },
      take: limit,
      select: { notificationUuid: true },
    });
    return rows.map((row) => row.notificationUuid);
  }

  // ────────────────────────────── ODCZYT ──────────────────────────────

  /**
   * Subskrypcje należące do tej osoby — do ekranu „Zarządzaj subskrypcją”
   * i do wymogu App Store 3.1.2(a) (stan musi być widoczny w aplikacji).
   */
  async forUser(
    userId: string,
    now: Date = new Date(),
  ): Promise<SubscriptionSummary[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        identityHash: true,
        appleSub: true,
        googleId: true,
        authProvider: true,
      },
    });
    const identityHash =
      user?.identityHash ??
      (user ? purchaseIdentityHashForUser(user) : null) ??
      null;
    if (!identityHash) return [];
    const rows = await this.prisma.subscription.findMany({
      where: { identityHash },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.toSummary(row, now));
  }

  private toSummary(
    row: {
      id: string;
      productId: string;
      status: string;
      expiresAt: Date | null;
      graceExpiresAt: Date | null;
      neverExpires: boolean;
      revokedAt: Date | null;
      autoRenewStatus: boolean | null;
      environment: string | null;
      operatorHoldAt: Date | null;
      operatorHoldReason: string | null;
      messagesLimitSnapshot: number | null;
      plansLimitSnapshot: number | null;
      provider: string;
      createdAt: Date;
    },
    now: Date,
  ): SubscriptionSummary {
    return {
      id: row.id,
      productId: row.productId,
      productName: SUBSCRIPTION_PRODUCTS[row.productId]?.name ?? null,
      status: row.status,
      alive: subscriptionAlive(
        {
          id: row.id,
          provider: row.provider,
          productId: row.productId,
          status: row.status,
          expiresAt: row.expiresAt,
          graceExpiresAt: row.graceExpiresAt,
          neverExpires: row.neverExpires,
          revokedAt: row.revokedAt,
          messagesLimitSnapshot: row.messagesLimitSnapshot,
          plansLimitSnapshot: row.plansLimitSnapshot,
          createdAt: row.createdAt,
          environment: row.environment,
          operatorHoldAt: row.operatorHoldAt,
        },
        now,
      ),
      expiresAt: row.expiresAt?.toISOString() ?? null,
      graceExpiresAt: row.graceExpiresAt?.toISOString() ?? null,
      autoRenews: row.autoRenewStatus,
      environment: row.environment,
      messagesLimit: row.messagesLimitSnapshot,
      plansLimit: row.plansLimitSnapshot,
      operatorHold: row.operatorHoldAt ? (row.operatorHoldReason ?? '') : null,
    };
  }

  /** Zakres licznika kwoty tej subskrypcji — do panelu operatora. */
  scopeOf(subscriptionId: string): string {
    return subscriptionScopeId(subscriptionId);
  }
}
