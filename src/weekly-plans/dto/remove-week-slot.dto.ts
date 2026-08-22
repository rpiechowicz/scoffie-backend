import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { MealType } from '@prisma/client';
import { MEAL_TYPE_VALUES } from '../../common/meal-types';

const dayOfWeek = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
const mealType = MEAL_TYPE_VALUES;

export class RemoveWeekSlotDto {
  @ApiProperty({ enum: dayOfWeek })
  @IsIn(dayOfWeek)
  dayOfWeek: (typeof dayOfWeek)[number];

  @ApiProperty({ enum: mealType })
  @IsIn(mealType)
  mealType: MealType;

  /**
   * Which variant to drop when the slot holds several. Omitted clears the
   * whole slot, which is what pre-split clients have always meant by this
   * call.
   */
  @ApiPropertyOptional({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsOptional()
  @IsString()
  recipeId?: string;
}
