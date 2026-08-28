import { HttpStatus } from '@nestjs/common';
import { AppException } from './app-exception';

/**
 * Słownik alergenów. Te siedem wartości to DOKŁADNIE `rawValue` enuma
 * `Allergen` z iOS (`Models/Components/DietPreference.swift`) — kolumna
 * `UserPreference.allergens` jest `String[]`, więc baza nie pilnuje niczego
 * i bez tej listy lądowało w niej dowolne słowo (WebSocket nie uruchamia
 * dekoratorów z DTO — patrz `weekly-plans.service.ts`,
 * `resolvePlannedServings`).
 *
 * Dodanie wartości (seler / gorczyca / sezam) MUSI wyjść na produkcję ZANIM
 * klient iOS zacznie ją wysyłać — inaczej serwer odrzuci cały zapis
 * preferencji tego użytkownika. Stara aplikacja nie skasuje nowej wartości
 * z konta dopiero od buildu z unią „znane ∪ nieznane" (`SettingsView`).
 */
export const ALLERGEN_IDS = [
  'gluten',
  'lactose',
  'eggs',
  'nuts',
  'peanuts',
  'fish',
  'soy',
] as const;

export type AllergenId = (typeof ALLERGEN_IDS)[number];

/** Mutowalna kopia dla `@IsIn` i `@ApiProperty({ enum })`. */
export const ALLERGEN_ID_VALUES: string[] = [...ALLERGEN_IDS];

export function isAllergenId(value: unknown): value is AllergenId {
  return typeof value === 'string' && ALLERGEN_ID_VALUES.includes(value);
}

/**
 * trim → lowercase → odrzuć puste → deduplikuj → posortuj, a nieznane id
 * ZGŁOŚ zamiast po cichu wyrzucić: klient, który wysyła „shellfish", ma się
 * o tym dowiedzieć, a nie myśleć, że użytkownik jest chroniony.
 *
 * `wsRespond` przekazuje klientowi tylko `code`/`message`/`status`, nie
 * `details` — dlatego komunikat wymienia nieznane wartości wprost.
 */
export function normalizeAllergenIds(
  values: readonly unknown[],
): AllergenId[] {
  if (!Array.isArray(values)) {
    throw new AppException(
      'VALIDATION_ERROR',
      'allergens musi być listą identyfikatorów',
      HttpStatus.BAD_REQUEST,
      { field: 'allergens', allowed: ALLERGEN_ID_VALUES },
    );
  }

  const cleaned = Array.from(
    new Set(
      values
        .map((value) =>
          typeof value === 'string' ? value.trim().toLowerCase() : '',
        )
        .filter(Boolean),
    ),
  ).sort();

  const unknown = cleaned.filter((value) => !isAllergenId(value));
  if (unknown.length > 0) {
    throw new AppException(
      'VALIDATION_ERROR',
      `Nieznane alergeny: ${unknown.join(', ')}`,
      HttpStatus.BAD_REQUEST,
      { field: 'allergens', unknown, allowed: ALLERGEN_ID_VALUES },
    );
  }

  return cleaned as AllergenId[];
}
