import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsIn, IsOptional, IsUUID } from 'class-validator';
import { DayOfWeek, MealType } from '@prisma/client';
import { MEAL_TYPE_VALUES } from '../../common/meal-types';

/** Walidowane w serwisie przez `validateDto` — patrz `UpsertWeekSlotDto`. */
export class RemoveWeekSlotDto {
  @ApiProperty({ enum: DayOfWeek })
  @IsEnum(DayOfWeek)
  dayOfWeek: DayOfWeek;

  @ApiProperty({ enum: MEAL_TYPE_VALUES })
  @IsIn(MEAL_TYPE_VALUES)
  mealType: MealType;

  /**
   * Which variant to drop when the slot holds several. Omitted clears the
   * whole slot, which is what pre-split clients have always meant by this
   * call.
   */
  @ApiPropertyOptional({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsOptional()
  @IsUUID()
  recipeId?: string;
}
