import { acceptedTransactionEnvironments } from './apple-environment';
import { SUBSCRIPTION_PRODUCTS } from './subscription-products';

/**
 * Kiedy subskrypcja daje dostęp i która wygrywa, gdy jest ich kilka.
 *
 * DLACZEGO TU, A NIE W MODULE ASYSTENTA. To jest wiedza o subskrypcjach, nie o
 * asystencie: czytają ją i moduł płatności (żeby powiedzieć „aktywna"), i
 * `resolvePlan` (żeby nadać PRO). Trzymanie jej w `src/agent/` zmusiłoby
 * płatności do importu z asystenta, czego pilnuje reguła granicy modułu —
 * i słusznie, bo to asystent zależy od subskrypcji, nigdy odwrotnie.
 */

/**
 * Margines na zegar. Apple podaje `expiresAt` ze swojego zegara, nasz serwer
 * porównuje ze swoim, a powiadomienie o odnowieniu potrafi przyjść kilkanaście
 * sekund po czasie. Bez marginesu płacący klient dostaje 429 w sekundzie, w
 * której Apple właśnie pobrało pieniądze.
 */
export const SUBSCRIPTION_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Domyślna łaska płatnicza, gdy Apple przysłało status GRACE bez daty końca.
 * 16 dni to maksimum, jakie Apple w ogóle daje — pomyłka w tę stronę kosztuje
 * najwyżej pół miesiąca jednej subskrypcji, pomyłka w drugą odcina klienta,
 * któremu Apple obiecało czas na poprawienie karty.
 */
export const DEFAULT_GRACE_DAYS = 16;

/** Kandydat na źródło PRO — tyle pól, ile trzeba do rozstrzygnięcia. */
export type SubscriptionCandidate = {
  id: string;
  provider: string;
  productId: string;
  status: string;
  expiresAt: Date | null;
  graceExpiresAt: Date | null;
  neverExpires: boolean;
  revokedAt: Date | null;
  messagesLimitSnapshot: number | null;
  plansLimitSnapshot: number | null;
  createdAt: Date;
  /**
   * Środowisko App Store transakcji (`Production` / `Sandbox`); `null` dla
   * nadania ręcznego, które nie chodzi przez Apple i zawsze się liczy.
   */
  environment?: string | null;
  /**
   * Blokada operatora. Ustawiona ręcznie po zwrocie pieniędzy albo nadużyciu i
   * NIGDY nieczyszczona przez uzgadnianie ani zgłoszenie z telefonu — inaczej
   * „Przywróć zakupy" cofało decyzję obsługi jednym kliknięciem klienta.
   */
  operatorHoldAt?: Date | null;
};

/**
 * Czy subskrypcja daje PRO TERAZ.
 *
 * Trzy rzeczy, których poprzednia wersja nie robiła:
 * 1. `revokedAt` (zwrot pieniędzy, cofnięcie przez Apple) ucina dostęp
 *    natychmiast, niezależnie od `status` i `expiresAt`.
 * 2. Brak `expiresAt` NIE znaczy „żywa na zawsze" — dla APPLE znaczy „nie
 *    wiemy", czyli martwa. Wieczne bywa tylko nadanie ręczne z `neverExpires`.
 * 3. GRACE ma własną datę końca. Bez niej status GRACE nigdy by nie zadziałał,
 *    bo `expiresAt` z definicji leży już w przeszłości.
 *
 * DWIE RZECZY DOŁOŻONE PO AUDYCIE 4.09:
 * 4. Blokada operatora ucina dostęp niezależnie od tego, co mówi Apple.
 * 5. Wiersz ze środowiska, którego teraz nie uznajemy (sandbox na produkcji),
 *    nie daje PRO. Bez tego literówka w `APPLE_ENVIRONMENT` zostawiała po
 *    sobie wiersze rozdające darmowe PRO na zawsze — poprawienie zmiennej ich
 *    nie ruszało, bo nikt ich już nie pytał o środowisko.
 */
export function subscriptionAlive(
  sub: SubscriptionCandidate,
  now: Date,
): boolean {
  if (sub.operatorHoldAt) return false;
  if (sub.revokedAt) return false;
  if (
    sub.environment &&
    !acceptedTransactionEnvironments().includes(
      sub.environment as 'Production' | 'Sandbox',
    )
  ) {
    return false;
  }
  if (sub.status !== 'ACTIVE' && sub.status !== 'GRACE') return false;
  if (sub.neverExpires) return true;
  const until =
    sub.status === 'GRACE'
      ? (sub.graceExpiresAt ??
        (sub.expiresAt
          ? new Date(
              sub.expiresAt.getTime() + DEFAULT_GRACE_DAYS * 24 * 3600 * 1000,
            )
          : null))
      : sub.expiresAt;
  if (!until) return false;
  return until.getTime() + SUBSCRIPTION_CLOCK_SKEW_MS > now.getTime();
}

/** Prefiks klucza okresu rozliczeniowego subskrypcji. */
export const BILLING_PERIOD_PREFIX = 'okres:';

/**
 * Okres puli dla subskrypcji: KONIEC OPŁACONEGO OKRESU, nie koniec miesiąca.
 *
 * DLACZEGO NIE MIESIĄC KALENDARZOWY (decyzja Rafała, 4.09.2026). Miesiąc
 * kalendarzowy nie ma nic wspólnego z tym, za co człowiek zapłacił. Kupując
 * 15.09 dostawał resztę września i PEŁNĄ pulę od 1.10 — dwie pule za jedną
 * opłatę — a wracając po przerwie 20.10 do okresu, który już opłacił we
 * wrześniu, trafiał na licznik wyzerowany albo nie, zależnie od dnia miesiąca.
 * Teraz pula idzie za umową: kupione 15.09 odnawia się 15.10, tak jak
 * odnawia się płatność u Apple.
 *
 * KLUCZEM JEST `expiresAt`, bo to jedyna data, którą Apple daje wprost i która
 * przesuwa się DOKŁADNIE przy odnowieniu — zmiana wartości sama otwiera nową
 * pulę, bez żadnego crona i bez pilnowania, kiedy „minął miesiąc". W łasce
 * płatniczej `expiresAt` stoi w miejscu, więc człowiek na przeterminowanej
 * karcie NIE dostaje świeżej puli — dostaje resztę tej, za którą zapłacił.
 *
 * `null` dla nadania operatora i wieczystego (brak okresu rozliczeniowego) —
 * wołający schodzi wtedy na miesiąc kalendarzowy.
 */
export function billingPeriodKey(
  sub: Pick<SubscriptionCandidate, 'expiresAt' | 'neverExpires'> | undefined,
): string | null {
  if (!sub || sub.neverExpires || !sub.expiresAt) return null;
  return `${BILLING_PERIOD_PREFIX}${sub.expiresAt.toISOString().slice(0, 10)}`;
}

/**
 * Zwycięzca wśród subskrypcji domowników.
 *
 * Klucz porównania: `żywa` → `wyższy limit wiadomości` → `starsza`.
 *
 * ŻYWOTNOŚĆ PRZED LIMITEM jest tu istotna, nie kosmetyczna: gdyby najpierw szedł
 * limit, wystarczyłoby kupić Rodzinę, poprosić o zwrot pieniędzy i martwa
 * Rodzina zasłaniałaby żywe Solo współdomownika. Starsza przy remisie, żeby
 * wynik był stabilny — dom nie ma migać między dwiema równymi subskrypcjami.
 */
export function pickBestSubscription(
  candidates: SubscriptionCandidate[],
  now: Date,
): SubscriptionCandidate | null {
  const alive = candidates.filter((candidate) =>
    subscriptionAlive(candidate, now),
  );
  if (alive.length === 0) return null;
  const messagesOf = (candidate: SubscriptionCandidate) =>
    Math.max(
      candidate.messagesLimitSnapshot ?? 0,
      SUBSCRIPTION_PRODUCTS[candidate.productId]?.messagesPerMonth ?? 0,
    );
  return alive.sort((a, b) => {
    const byLimit = messagesOf(b) - messagesOf(a);
    if (byLimit !== 0) return byLimit;
    return a.createdAt.getTime() - b.createdAt.getTime();
  })[0];
}
