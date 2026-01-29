import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString } from 'class-validator';

const dayOfWeek = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
const mealType = ['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK'] as const;

export class CreatePlanItemDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsString()
  recipeId: string;

  @ApiProperty({ enum: dayOfWeek })
  @IsIn(dayOfWeek)
  dayOfWeek: (typeof dayOfWeek)[number];

  @ApiProperty({ enum: mealType })
  @IsIn(mealType)
  mealType: (typeof mealType)[number];
}
