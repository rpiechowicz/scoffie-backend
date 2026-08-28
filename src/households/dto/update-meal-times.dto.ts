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

/**
 * Waliduje mapę `slot → minuty od północy`. Ręcznie, bo `class-validator`
 * nie ma reguły na „słownik enum → liczba całkowita z zakresu".
 */
@ValidatorConstraint({ name: 'MealSlotTimes', async: false })
class MealSlotTimesConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }

    return Object.entries(value as Record<string, unknown>).every(
      ([key, minutes]) =>
        isMealType(key) &&
        typeof minutes === 'number' &&
        Number.isInteger(minutes) &&
        minutes >= 0 &&
        minutes < MINUTES_IN_DAY,
    );
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must map meal types (${MEAL_TYPE_VALUES.join(', ')}) to whole minutes from midnight (0-${MINUTES_IN_DAY - 1})`;
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
