import { ApiProperty } from '@nestjs/swagger';
import {
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { MealType } from '@prisma/client';
import { MEAL_TYPE_VALUES, isMealType } from '../../common/meal-types';

/** Doba ma 1440 minut; 1439 to 23:59. */
export const MINUTES_IN_DAY = 24 * 60;

function isValidMinutes(minutes: unknown): boolean {
  return (
    typeof minutes === 'number' &&
    Number.isInteger(minutes) &&
    minutes >= 0 &&
    minutes < MINUTES_IN_DAY
  );
}

/**
 * Waliduje mapę `slot → minuty od północy`. Ręcznie, bo `class-validator`
 * nie ma reguły na „słownik enum → liczba całkowita z zakresu".
 *
 * Do kroku 2 Fazy 0 ta reguła na WebSockecie nie działała wcale (mapa szła
 * 1:1 do kolumny Json) — dziś woła ją `validateDto` w serwisie, więc jest
 * jedyną bramką przed zapisem.
 */
@ValidatorConstraint({ name: 'MealSlotTimes', async: false })
class MealSlotTimesConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }

    return Object.entries(value as Record<string, unknown>).every(
      ([key, minutes]) => isMealType(key) && isValidMinutes(minutes),
    );
  }

  /**
   * Komunikat wskazuje KTÓRE wpisy są złe (`SNACKS: 480`, `BREAKFAST: "8:00"`),
   * nie tylko regułę — klient i asystent widzą, co poprawić, bez zgadywania.
   */
  defaultMessage(args: ValidationArguments): string {
    const rule = `${args.property} must map meal types (${MEAL_TYPE_VALUES.join(', ')}) to whole minutes from midnight (0-${MINUTES_IN_DAY - 1})`;
    const value: unknown = args.value;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return `${rule}; got ${Array.isArray(value) ? 'an array' : typeof value}`;
    }
    const invalid = Object.entries(value as Record<string, unknown>)
      .filter(([key, minutes]) => !isMealType(key) || !isValidMinutes(minutes))
      .map(([key, minutes]) => `${key}: ${JSON.stringify(minutes)}`);
    return invalid.length > 0
      ? `${rule}; invalid entries: ${invalid.join(', ')}`
      : rule;
  }
}

/**
 * Zmiana pór posiłków gospodarstwa.
 *
 * Mapa jest **pełna**, nie różnicowa: klient przysyła stan, jaki ma
 * obowiązywać. Slot nieobecny w mapie to slot bez stałej pory — tak działa
 * przekąska — więc pominięcia nie wolno czytać jako „zostaw, jak było".
 * Mapę wysyła wyłącznie klient, który zna wszystkie sloty.
 */
export class UpdateHouseholdMealTimesDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'integer' },
    example: {
      BREAKFAST: 480,
      SECOND_BREAKFAST: 630,
      LUNCH: 840,
      DINNER: 1200,
    },
  })
  @Validate(MealSlotTimesConstraint)
  mealSlotTimes: Partial<Record<MealType, number>>;
}
