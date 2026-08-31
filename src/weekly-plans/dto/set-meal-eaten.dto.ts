import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsIn, IsUUID } from 'class-validator';
import { DayOfWeek, MealType } from '@prisma/client';
import { MEAL_TYPE_VALUES } from '../../common/meal-types';

/**
 * Marks one planned meal as eaten (or un-eaten) by the calling user.
 *
 * The slot is addressed the same way `UpsertWeekSlotDto` addresses it —
 * (day, mealType, recipeId) — rather than by `planItemId`, because a client
 * that reloads a week gets fresh item ids from the server and would otherwise
 * hold a stale handle.
 *
 * Walidowane w serwisie przez `validateDto` — patrz `UpsertWeekSlotDto`.
 */
export class SetMealEatenDto {
  @ApiProperty({ enum: DayOfWeek })
  @IsEnum(DayOfWeek)
  dayOfWeek: DayOfWeek;

  @ApiProperty({ enum: MEAL_TYPE_VALUES })
  @IsIn(MEAL_TYPE_VALUES)
  mealType: MealType;

  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsUUID()
  recipeId: string;

  @ApiProperty({ description: 'true = eaten, false = clears the mark.' })
  @IsBoolean()
  isEaten: boolean;
}
