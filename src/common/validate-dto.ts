import { HttpStatus, ValidationError, ValidationPipe } from '@nestjs/common';
import type { ClassConstructor } from 'class-transformer';
import { AppException } from './app-exception';

/**
 * Jawna walidacja DTO — jedna warstwa dla WebSocketu, HTTP i wywołań
 * in-process (narzędzia asystenta wołają te same serwisy, co handlery).
 *
 * Dlaczego nie pipe: globalny `ValidationPipe` dociera tylko do kontrolerów
 * HTTP (moduł socketów tworzy własny `PipesContextCreator` bez konfiguracji
 * aplikacji), a `@UsePipes` na gatewayu rzuca PRZED handlerem — błąd omija
 * `wsRespond`, leci eventem `exception` i klient nigdy nie dostaje acka (iOS
 * czeka 3×6 s). Dlatego dekoratory class-validator na DTO były na WS martwe:
 * zły enum od klienta kończył się `PrismaClientValidationError` → 500.
 *
 * Helper opiera się na tym samym `ValidationPipe`, co HTTP (`app.setup.ts`),
 * więc `details` mają bit w bit ten sam kształt (`data.dayOfWeek must be one
 * of the following values: MON, …`) — klient i asystent widzą jeden format
 * niezależnie od transportu. Błąd to `AppException('VALIDATION_ERROR')` z
 * listą w `details`, rzucany w miejscu wywołania, czyli wewnątrz `wsRespond`.
 */
export type ValidateDtoOptions = {
  /**
   * `true` (domyślnie): nieznane pole = błąd — chroni serwisy przed
   * halucynowanymi polami asystenta i jest zgodne z HTTP. `false`: nieznane
   * pola są po cichu obcinane — dla kopert zdarzeń WS, gdzie stare buildy iOS
   * wysyłają jeszcze `userId` i inne pola sprzed Fazy 0.
   */
  forbidNonWhitelisted?: boolean;
};

class DtoValidationPipe extends ValidationPipe {
  /**
   * `createExceptionFactory` jest wołane w konstruktorze bazowym — nadpisanie
   * tutaj daje ten sam `flattenValidationErrors` (prefiks rodzica dla
   * zagnieżdżeń, `each` dla tablic), tylko z `AppException` zamiast
   * `BadRequestException`. `mapError` i tak zamieniłby jedno w drugie; różnica
   * jest w typie, na którym mogą polegać testy i narzędzia.
   */
  createExceptionFactory(): (errors: ValidationError[]) => unknown {
    return (errors: ValidationError[] = []) => {
      const details = this.flattenValidationErrors(errors);
      return new AppException(
        'VALIDATION_ERROR',
        details.join(', '),
        HttpStatus.BAD_REQUEST,
        details,
      );
    };
  }
}

const strictPipe = new DtoValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const lenientPipe = new DtoValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: false,
  transform: true,
});

/**
 * Waliduje `plain` względem dekoratorów klasy `cls` i oddaje instancję po
 * transformacji (`@Transform`, `@Type`) — dokładnie to, co dostałby kontroler
 * HTTP z globalnego pipe'a.
 *
 * `undefined`/`null` na wejściu to pusty obiekt: brak `data` w payloadzie
 * daje listę brakujących pól, nie `TypeError` na `dto.dayOfWeek`.
 */
export async function validateDto<T extends object>(
  cls: ClassConstructor<T>,
  plain: unknown,
  options: ValidateDtoOptions = {},
): Promise<T> {
  const pipe = options.forbidNonWhitelisted === false ? lenientPipe : strictPipe;
  return (await pipe.transform(plain, { type: 'body', metatype: cls })) as T;
}

/**
 * Koperta zdarzenia WS (`{ userId?, householdId, weekStart, data }`):
 * whitelist bez `forbidNonWhitelisted`. Nieznane pole na kopercie nie jest
 * błędem — stare buildy dokładają ich sporo, a handler i tak czyta pola po
 * nazwie. `data`/`filters` walidują dopiero serwisy, każde pole dokładnie raz.
 */
export function validateWsPayload<T extends object>(
  cls: ClassConstructor<T>,
  payload: unknown,
): Promise<T> {
  return validateDto(cls, payload, { forbidNonWhitelisted: false });
}
