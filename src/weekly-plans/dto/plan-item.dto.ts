import { ApiProperty } from '@nestjs/swagger';
import { MEAL_TYPE_VALUES } from '../../common/meal-types';
import { RecipeDto } from '../../recipes/dto/recipe.dto';

export class PlanItemPortionDto {
  @ApiProperty()
  userId: string;

  /** Porcja tej osoby w porcjach przepisu, wielokrotność 0,05. */
  @ApiProperty({ example: 1.25, minimum: 0.1, maximum: 6 })
  servings: number;
}

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

  /**
   * Porcje per osoba (Etap 2.2). Puste = równy podział `plannedServings`
   * między jedzących (pozycje sprzed alokacji). Niepuste = źródło prawdy:
   * każda osoba z audytorium ma dokładnie jeden wpis (wielokrotność 0,05),
   * gotujemy Σ porcji, a `plannedServings` jest pochodną `ceil(Σ)`.
   */
  @ApiProperty({ type: [PlanItemPortionDto] })
  portions: PlanItemPortionDto[];

  @ApiProperty()
  createdAt: Date;
}
