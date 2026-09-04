import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Tożsamość zakupowa — pseudonim osoby, który PRZEŻYWA skasowanie konta.
 *
 * PO CO. Rafał postawił wprost jedno wymaganie: „jak ktoś użyje darmowy trial,
 * usunie konto i na nowo się zarejestruje, to powinno to trzymać jakoś w bazie,
 * aby znów nie mógł korzystać". `User.id` tego nie umie — ginie razem z kontem.
 * `appleSub` umie, bo Apple wydaje ten sam `sub` temu samemu człowiekowi w tej
 * samej aplikacji na zawsze, ale trzymanie go po skasowaniu konta byłoby
 * trzymaniem identyfikatora osoby, która właśnie poprosiła o usunięcie danych.
 *
 * Hasz z kluczem rozwiązuje jedno i drugie. Zostaje 64 znaki heksadecymalne,
 * z których nie da się odtworzyć `sub`, a które ta sama osoba dostanie znowu
 * przy ponownym logowaniu. Na tym wiszą DWIE rzeczy:
 *
 *   • pula próbna — licznik w zakresie `trial:<hasz>`, jedna na życie osoby;
 *   • subskrypcja — `Subscription.identityHash`, żeby opłacone PRO wróciło
 *     samo, gdy ktoś skasuje konto i zaloguje się ponownie tym samym Apple ID.
 *
 * RODO. To jest pseudonimizacja, nie anonimizacja — dalej są to dane osobowe
 * i tak trzeba je opisać w rejestrze czynności. Podstawa: prawnie uzasadniony
 * interes (art. 6 ust. 1 lit. f) — zapobieganie nadużyciu darmowej próby i
 * odtworzenie opłaconego świadczenia. To jedyny ślad zostawiany po usunięciu
 * konta i musi być wymieniony w polityce prywatności oraz w odpowiedzi na
 * żądanie z art. 15.
 *
 * PIEPRZ NIE MOŻE SIĘ ZMIENIĆ. Zmiana `PURCHASE_IDENTITY_PEPPER` przestawia
 * WSZYSTKIE hasze: każdy dostaje świeżą pulę próbną, a każda opłacona
 * subskrypcja przestaje pasować do swojego właściciela. Rotacja tego sekretu
 * jest równoznaczna z migracją danych — opisane w `docs/ROTACJA-SEKRETOW.md`.
 */

/**
 * Wartość awaryjna. Zmienna środowiskowa MUSI mieć domyślną wartość w kodzie,
 * ale ta akurat nie jest sekretem chroniącym dostęp — chroni przed odtworzeniem
 * `appleSub` z wycieku bazy. Bez ustawionej zmiennej hasze są przewidywalne dla
 * kogoś, kto zna ten kod, więc `assertEnv` krzyczy o tym przy starcie
 * produkcji. Nie jest to jednak powód, żeby aplikacja nie wstała: pusty pieprz
 * psuje prywatność, a brak startu psuje wszystko.
 */
const FALLBACK_PEPPER = 'scoffie-purchase-identity-fallback';

export function purchaseIdentityPepper(): string {
  const fromEnv = process.env.PURCHASE_IDENTITY_PEPPER?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : FALLBACK_PEPPER;
}

/** Czy pieprz jest prawdziwy (do ostrzeżenia przy starcie produkcji). */
export function hasRealPurchaseIdentityPepper(): boolean {
  return purchaseIdentityPepper() !== FALLBACK_PEPPER;
}

/**
 * Hasz tożsamości zakupowej z identyfikatora dostawcy logowania.
 *
 * `provider` wchodzi do materiału hasza, żeby to samo konto Google i Apple o
 * przypadkiem równym `sub` nie zlało się w jedną tożsamość.
 *
 * `null` dla konta bez żadnego zewnętrznego identyfikatora — takich nie ma poza
 * testami, ale wołający musi umieć się z tym obejść (patrz `identityScope`).
 */
export function purchaseIdentityHash(
  provider: string | null | undefined,
  sub: string | null | undefined,
): string | null {
  const normalized = sub?.trim();
  if (!normalized) return null;
  return createHmac('sha256', purchaseIdentityPepper())
    .update(`${provider ?? 'UNKNOWN'}:${normalized}`)
    .digest('hex');
}

/**
 * Hasz dla użytkownika, jakkolwiek się logował. Apple ma pierwszeństwo, bo tylko
 * ono jest bramką zakupu w App Store.
 */
export function purchaseIdentityHashForUser(user: {
  authProvider?: string | null;
  appleSub?: string | null;
  googleId?: string | null;
}): string | null {
  if (user.appleSub) return purchaseIdentityHash('APPLE', user.appleSub);
  if (user.googleId) return purchaseIdentityHash('GOOGLE', user.googleId);
  return null;
}

/** Prefiks zakresu licznika puli próbnej. */
export const TRIAL_SCOPE_PREFIX = 'trial:';
/** Prefiks zakresu licznika kwoty subskrypcji. */
export const SUBSCRIPTION_SCOPE_PREFIX = 'sub:';

/**
 * Zakres licznika puli próbnej dla osoby.
 *
 * DLACZEGO NIE GOSPODARSTWO. Do tej pory pula próbna liczyła się w zakresie
 * `householdId` z okresem `trial`, czyli „jedna próba na dom". Wyjście z domu i
 * założenie nowego (dwa kliknięcia, zero łamania regulaminu) dawało świeżą pulę
 * — bez kasowania konta, bez nowego Apple ID. Zakres na osobie zamyka to
 * całkowicie: dom nie ma nic wspólnego z tym, ile prób zostało.
 *
 * Skutek uboczny jest zamierzony: czteroosobowy dom ma cztery próby po pięć
 * wiadomości zamiast jednej piątki na wszystkich. To kosztuje grosze
 * (≈$0,03 za wiadomość), a jest uczciwe — każdy człowiek dostaje swoją próbę.
 *
 * `identityHash` jest pusty tylko do pierwszego zalogowania po wdrożeniu tej
 * zmiany; wtedy zakres siada na `User.id` i przestaje przeżywać skasowanie
 * konta. Samo się naprawia przy najbliższym logowaniu.
 */
export function trialScopeId(
  identityHash: string | null | undefined,
  userId: string,
): string {
  return identityHash
    ? `${TRIAL_SCOPE_PREFIX}${identityHash}`
    : `${TRIAL_SCOPE_PREFIX}user:${userId}`;
}

/** Zakres licznika kwoty dla żywej subskrypcji — wędruje razem z umową. */
export function subscriptionScopeId(subscriptionId: string): string {
  return `${SUBSCRIPTION_SCOPE_PREFIX}${subscriptionId}`;
}

/**
 * Porównanie haszy w stałym czasie. Używane tam, gdzie hasz z żądania trafia na
 * hasz z bazy (zgłoszenie transakcji) — różnica czasu nie ma tu prawa
 * podpowiadać, ile znaków się zgadza.
 */
export function identityHashEquals(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
