/**
 * Czy ten mail w ogóle ma prawo powstać.
 *
 * Jedna czysta funkcja zamiast trzech `if`-ów rozsypanych po wyzwalaczach:
 * powodów odmowy jest kilka, każdy da się przeoczyć w nowym miejscu, a cena
 * przeoczenia jest asymetryczna — mail wysłany na martwy adres psuje
 * reputację domeny WSZYSTKIM pozostałym wiadomościom.
 */

export type MailRefusal =
  /** Poczta wyłączona zmienną środowiskową — nie kolejkujemy nic. */
  | 'MAIL_DISABLED'
  /** Konto bez adresu. Przy Sign in with Apple to normalny stan, nie błąd. */
  | 'NO_ADDRESS'
  /** Adres nie wygląda na adres — nie ma po co pytać dostawcy. */
  | 'INVALID_ADDRESS'
  /** Adres po twardym odrzucie albo skardze na spam. */
  | 'SUPPRESSED';

export type MailEligibility =
  | { ok: true; to: string }
  | { ok: false; reason: MailRefusal };

/**
 * Postać do PORÓWNAŃ (lista wykluczeń, deduplikacja). Do wysyłki idzie adres
 * w oryginalnej wielkości liter — RFC pozwala serwerowi rozróżniać część
 * przed małpą, więc nie mamy prawa jej zmieniać; do porównania i tak
 * sprowadzamy obie strony do małych liter, bo w praktyce nikt nie prowadzi
 * dwóch różnych skrzynek różniących się wielkością liter.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Celowo luźny wzorzec: jeden `@`, coś po obu stronach, kropka w domenie
 * i żadnych spacji. Nie próbujemy powtarzać RFC 5322 — od odsiewania
 * naprawdę martwych adresów jest lista wykluczeń zasilana odrzutami,
 * a nadgorliwy wzorzec odciąłby prawdziwe skrzynki.
 */
const SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function looksLikeEmail(email: string): boolean {
  const value = email.trim();
  return value.length <= 254 && SHAPE.test(value);
}

export function checkEligibility(input: {
  email: string | null | undefined;
  mailEnabled: boolean;
  suppressed: boolean;
}): MailEligibility {
  if (!input.mailEnabled) return { ok: false, reason: 'MAIL_DISABLED' };

  const to = (input.email ?? '').trim();
  if (to === '') return { ok: false, reason: 'NO_ADDRESS' };
  if (!looksLikeEmail(to)) return { ok: false, reason: 'INVALID_ADDRESS' };
  if (input.suppressed) return { ok: false, reason: 'SUPPRESSED' };

  return { ok: true, to };
}

/**
 * Czy adres jest aliasem Apple Private Relay.
 *
 * Nie zmienia decyzji o wysyłce — służy diagnostyce. Gdyby domena nadawcza
 * wypadła z rejestru „Sign in with Apple for Email Communication", odbijać
 * zacznie WYŁĄCZNIE ta grupa adresów, a bez tego rozróżnienia w metrykach
 * wygląda to jak przypadkowy wzrost odrzutów.
 */
export function isAppleRelay(email: string): boolean {
  return normalizeEmail(email).endsWith('@privaterelay.appleid.com');
}
