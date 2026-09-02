/**
 * Wersje dokumentów prawnych i rodzaje zgód — STAŁE w kodzie.
 *
 * Nie zmienna środowiskowa: literówka w `railway variables` unieważniałaby
 * zgody wszystkim użytkownikom naraz i blokowała asystenta całej instalacji.
 * Nowa wersja dokumentu = nowa data tutaj + ten sam tekst w aplikacji i na
 * stronie (`weekly-meals-ios/docs/`). Zgoda jest ważna, gdy jej wersja nie
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
] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];
export const CONSENT_KIND_VALUES: string[] = [...CONSENT_KINDS];

export const CONSENT_ACTIONS = ['GRANTED', 'REVOKED'] as const;
export type ConsentAction = (typeof CONSENT_ACTIONS)[number];
export const CONSENT_ACTION_VALUES: string[] = [...CONSENT_ACTIONS];

/** Bieżąca wersja każdego dokumentu (to klient wysyła w zdarzeniu). */
export const LEGAL_DOCUMENT_VERSIONS: Record<ConsentKind, string> = {
  // Polityka i warunki v1.1 z 1.08.2026 — tekst w AuthFooterView.swift
  // i docs/privacy. Wersja 2 (asystent, Zdrowie, Cookidoo, retencja)
  // dostanie własną datę, gdy Rafał zatwierdzi treść.
  TERMS: '2026-08-01',
  PRIVACY: '2026-08-01',
  AI_ASSISTANT: '2026-09-02',
  COOKIDOO: '2026-09-02',
  AGE_16: '2026-09-02',
};

/**
 * Najstarsza wersja, którą jeszcze uznajemy. Podnosić tylko wtedy, gdy zmiana
 * dokumentu jest istotna (nowy odbiorca danych, nowy cel) — wtedy każdy musi
 * kliknąć od nowa. Poprawki redakcyjne zostawiają minimum bez zmian.
 */
export const MINIMUM_CONSENT_VERSIONS: Record<ConsentKind, string> = {
  TERMS: '2026-08-01',
  PRIVACY: '2026-08-01',
  AI_ASSISTANT: '2026-09-02',
  COOKIDOO: '2026-09-02',
  AGE_16: '2026-09-02',
};

export function isConsentKind(value: unknown): value is ConsentKind {
  return typeof value === 'string' && CONSENT_KIND_VALUES.includes(value);
}

/** `YYYY-MM-DD` porównywane leksykograficznie. */
export function isVersionCurrent(kind: ConsentKind, version: string): boolean {
  return version >= MINIMUM_CONSENT_VERSIONS[kind];
}
