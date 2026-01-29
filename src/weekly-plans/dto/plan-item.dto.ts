import { ApiProperty } from '@nestjs/swagger';

export class PlanItemDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  weeklyPlanId: string;

  @ApiProperty()
  recipeId: string;

  @ApiProperty({ enum: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] })
  dayOfWeek: string;

  @ApiProperty({ enum: ['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK'] })
  mealType: string;

  @ApiProperty()
  createdAt: Date;
}
