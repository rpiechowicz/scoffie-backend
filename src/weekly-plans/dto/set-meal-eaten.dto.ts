import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsString } from 'class-validator';

const dayOfWeek = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
const mealType = ['BREAKFAST', 'LUNCH', 'DINNER'] as const;

/**
 * Marks one planned meal as eaten (or un-eaten) by the calling user.
 *
 * The slot is addressed the same way `UpsertWeekSlotDto` addresses it —
 * (day, mealType, recipeId) — rather than by `planItemId`, because a client
 * that reloads a week gets fresh item ids from the server and would otherwise
 * hold a stale handle.
 */
export class SetMealEatenDto {
  @ApiProperty({ enum: dayOfWeek })
  @IsIn(dayOfWeek)
  dayOfWeek: (typeof dayOfWeek)[number];

  @ApiProperty({ enum: mealType })
  @IsIn(mealType)
  mealType: (typeof mealType)[number];

  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsString()
  recipeId: string;

  @ApiProperty({ description: 'true = eaten, false = clears the mark.' })
  @IsBoolean()
  isEaten: boolean;
}
