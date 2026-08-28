import { HttpStatus } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { AppException } from './app-exception';

/**
 * JEDNA definicja „to jest UUID" dla bramek w serwisach i `@IsUUID()` w DTO:
 * validator.js w trybie `all` (wersje 1–8 z poprawnym wariantem, nil, max;
 * wielkość liter bez znaczenia — iOS wysyła `uuidString` wielkimi literami).
 * Wszystkie identyfikatory w bazie i katalogu (`22222222-2222-4222-8222-…`) są
 * zgodne; śmieci typu `hh-1` albo obcięte id zatrzymują się tu zamiast na
 * P2023 z Postgresa (`@db.Uuid`) → 500.
 */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && isUUID(value);
}

/**
 * Bramka na skalarne identyfikatory z koperty zdarzenia albo z argumentu
 * narzędzia asystenta (`householdId`, `recipeId`, `archiveId`, …) — tam, gdzie
 * nie ma DTO z `@IsUUID()`. Komunikat w stylu class-validator, żeby `details`
 * wyglądały tak samo niezależnie od tego, która warstwa złapała błąd.
 */
export function assertUuid(value: unknown, field: string): string {
  if (!isUuid(value)) {
    const detail = `${field} must be a UUID`;
    throw new AppException(
      'VALIDATION_ERROR',
      detail,
      HttpStatus.BAD_REQUEST,
      [detail],
    );
  }
  return value;
}
