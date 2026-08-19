import { ApiProperty } from '@nestjs/swagger';
import { RecipeDto } from '../../recipes/dto/recipe.dto';

export class PlanItemDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  weeklyPlanId: string;

  @ApiProperty()
  recipeId: string;

  @ApiProperty({ type: RecipeDto })
  recipe?: RecipeDto;

  @ApiProperty({ enum: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] })
  dayOfWeek: string;

  @ApiProperty({ enum: ['BREAKFAST', 'LUNCH', 'DINNER'] })
  mealType: string;

  /** Household member ids this item is for. Empty = everyone („Wspólne"). */
  @ApiProperty({ type: [String] })
  participantIds: string[];

  @ApiProperty()
  createdAt: Date;
}
