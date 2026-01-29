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

  @ApiProperty({ enum: ['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK'] })
  mealType: string;

  @ApiProperty()
  createdAt: Date;
}
