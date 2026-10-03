import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsIn, IsInt, IsUUID, Max, Min } from 'class-validator';
import { DayOfWeek, MealType } from '@prisma/client';
import { MEAL_TYPE_VALUES } from '../../common/meal-types';

/**
 * „Zjedzone” po gotowaniu w trybie Gotuj (docs iOS Gotuj D21, D28).
 *
 * Porę wybiera telefon — zna godzinę i strefę osoby, pory domu
 * (`mealSlotTimes` albo swoje domyślne) i `suitableMealTypes` przepisu;
 * serwer strefy czasowej nie zna. Dzień to DZIŚ u gotującego.
 *
 * Walidowane w serwisie przez `validateDto` — patrz `UpsertWeekSlotDto`.
 */
export class LogCookedMealDto {
  @ApiProperty({ enum: DayOfWeek })
  @IsEnum(DayOfWeek)
  dayOfWeek: DayOfWeek;

  @ApiProperty({ enum: MEAL_TYPE_VALUES })
  @IsIn(MEAL_TYPE_VALUES)
  mealType: MealType;

  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsUUID()
  recipeId: string;

  /**
   * Na ile porcji gotowano (stepper powitania). Tyle co domowników albo
   * więcej = danie dla całego domu, mniej = tylko dla gotującego.
   */
  @ApiProperty({ example: 2, minimum: 1, maximum: 12 })
  @IsInt()
  @Min(1)
  @Max(12)
  servings: number;
}
