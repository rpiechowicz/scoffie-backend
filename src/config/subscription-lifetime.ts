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
 */
export function subscriptionAlive(
  sub: SubscriptionCandidate,
  now: Date,
): boolean {
  if (sub.revokedAt) return false;
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
