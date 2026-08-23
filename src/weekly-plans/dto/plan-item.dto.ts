import { ApiProperty } from '@nestjs/swagger';
import { MEAL_TYPE_VALUES } from '../../common/meal-types';
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

  @ApiProperty({ enum: MEAL_TYPE_VALUES })
  mealType: string;

  /** Household member ids this item is for. Empty = everyone („Wspólne"). */
  @ApiProperty({ type: [String] })
  participantIds: string[];

  /**
   * Household members who marked this meal as eaten. Per-user rather than a
   * flag, because a shared item is eaten by each member on their own
   * schedule — see `PlanItemConsumption`.
   */
  @ApiProperty({ type: [String] })
  eatenByUserIds: string[];

  /**
   * Ile porcji przepisu gotujemy w tym slocie — łącznie, nie na osobę.
   * Lista zakupów skaluje składniki przez `plannedServings / recipe.servings`.
   */
  @ApiProperty({ example: 2, minimum: 1, maximum: 12 })
  plannedServings: number;

  @ApiProperty()
  createdAt: Date;
}
