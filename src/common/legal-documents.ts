/**
 * Wersje dokumentów prawnych i rodzaje zgód — STAŁE w kodzie.
 *
 * Nie zmienna środowiskowa: literówka w `railway variables` unieważniałaby
 * zgody wszystkim użytkownikom naraz i blokowała asystenta całej instalacji.
 * Nowa wersja dokumentu = nowa data tutaj + ten sam tekst w aplikacji i na
 * stronie (`scoffie-ios/docs/`). Zgoda jest ważna, gdy jej wersja nie
 * jest STARSZA niż minimalna wymagana — nie „równa", żeby poprawka literówki
 * w polityce nie wymagała klikania od nowa.
 *
 * Daty jako `YYYY-MM-DD`, bo porównują się leksykograficznie.
 */
export const CONSENT_KINDS = [
  /** Warunki korzystania (regulamin, art. 8 UŚUDE). */
  'TERMS',
  /** Polityka prywatności (obowiązek informacyjny, art. 13 RODO). */
  'PRIVACY',
  /**
   * Wyraźna zgoda na wysyłanie danych o diecie i alergiach TEJ osoby do
   * modelu Anthropica (art. 9 ust. 2 lit. a RODO; App Store 5.1.2(i)).
   */
  'AI_ASSISTANT',
  /** Przekazanie hasła do konta Cookidoo (usługa trzecia, nieoficjalne API). */
  'COOKIDOO',
  /** Deklaracja ukończonych 16 lat (art. 8 RODO w Polsce). */
  'AGE_16',
  /**
   * Wyraźna zgoda na przetwarzanie danych o zdrowiu poza asystentem:
   * alergeny, sylwetka (wzrost, waga, płeć, rok), kroki ze Zdrowia
   * (art. 9 ust. 2 lit. a RODO). Zapisywana przez SERWER w chwili, gdy
   * użytkownik pierwszy raz podaje takie dane — samo podanie jest zgodą,
   * a dziennik ma to udowodnić (art. 7 ust. 1).
   */
  'HEALTH_DATA',
] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];
export const CONSENT_KIND_VALUES: string[] = [...CONSENT_KINDS];

export const CONSENT_ACTIONS = ['GRANTED', 'REVOKED'] as const;
export type ConsentAction = (typeof CONSENT_ACTIONS)[number];
export const CONSENT_ACTION_VALUES: string[] = [...CONSENT_ACTIONS];

/** Bieżąca wersja każdego dokumentu (to klient wysyła w zdarzeniu). */
export const LEGAL_DOCUMENT_VERSIONS: Record<ConsentKind, string> = {
  // Wersja 1.3 (ogłoszona 8.10.2026, obowiązuje od 22.10.2026 — 14 dni
  // z regulaminu, sekcja 14): darmowa pula asystenta odnawia się co 30 dni,
  // Usługodawca może zmienić jej wielkość i okres, w polityce liczniki
  // i data rozpoczęcia puli w śladzie tożsamości zakupowej. Zmiana na korzyść
  // użytkownika — minimum bez zmian, nikt nie klika od nowa.
  //
  // Wersja 1.2 z 2.10.2026: Resend (poczta o koncie) w polityce prywatności,
  // nocna kopia bazy na Railwayu zamiast GitHub Actions. Jedna data dla
  // wszystkich rodzajów, bo iOS wysyła JEDNĄ wersję (`LegalDocMeta`) przy
  // każdej zgodzie — ta MUSI wejść na prod przed buildem z nową datą
  // (wersja z przyszłości = odmowa zapisu zgody). Minimum bez zmian: Resend
  // wysyła pocztę od 11.09 w ramach umowy (bez nowej zgody), a starszy build
  // dalej wysyła 2026-09-23 i nie może dostać odmowy.
  TERMS: '2026-10-22',
  PRIVACY: '2026-10-22',
  AI_ASSISTANT: '2026-10-22',
  COOKIDOO: '2026-10-22',
  AGE_16: '2026-10-22',
  HEALTH_DATA: '2026-10-22',
};

/**
 * Najstarsza wersja, którą jeszcze uznajemy. Podnosić tylko wtedy, gdy zmiana
 * dokumentu jest istotna (nowy odbiorca danych, nowy cel) — wtedy każdy musi
 * kliknąć od nowa. Poprawki redakcyjne zostawiają minimum bez zmian.
 */
export const MINIMUM_CONSENT_VERSIONS: Record<ConsentKind, string> = {
  TERMS: '2026-09-15',
  PRIVACY: '2026-09-15',
  AI_ASSISTANT: '2026-09-15',
  COOKIDOO: '2026-09-15',
  AGE_16: '2026-09-15',
  HEALTH_DATA: '2026-09-15',
};

export function isConsentKind(value: unknown): value is ConsentKind {
  return typeof value === 'string' && CONSENT_KIND_VALUES.includes(value);
}

/** `YYYY-MM-DD` porównywane leksykograficznie. */
export function isVersionCurrent(kind: ConsentKind, version: string): boolean {
  return version >= MINIMUM_CONSENT_VERSIONS[kind];
}

/**
 * Wersja, którą klient naprawdę mógł zobaczyć: nie nowsza niż bieżąca.
 * Bez tego klient mógłby wysłać `9999-01-01` i mieć zgodę „ważną" po każdej
 * przyszłej zmianie dokumentu.
 */
export function isVersionKnown(kind: ConsentKind, version: string): boolean {
  return version <= LEGAL_DOCUMENT_VERSIONS[kind];
}
