import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayUnique, IsArray, IsIn } from 'class-validator';
import { MealType } from '@prisma/client';
import { MEAL_TYPE_VALUES } from '../../common/meal-types';

/**
 * Zmiana zestawu posiłków planowanych przez gospodarstwo.
 *
 * Lista jest **pełna**, nie różnicowa — klient przysyła stan, jaki ma
 * obowiązywać. Obowiązkową trójkę (śniadanie / obiad / kolacja) serwis
 * dokłada sam, więc jej pominięcie nie jest błędem, tylko brakiem efektu.
 */
export class UpdateHouseholdMealTypesDto {
  @ApiProperty({
    enum: MEAL_TYPE_VALUES,
    isArray: true,
    example: ['BREAKFAST', 'SECOND_BREAKFAST', 'LUNCH', 'DINNER'],
  })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(6)
  @IsIn(MEAL_TYPE_VALUES, { each: true })
  mealTypes: MealType[];
}
