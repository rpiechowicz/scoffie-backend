import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { DietPreferenceValue, UserGoal } from '@prisma/client';

/**
 * Partial-update payload for `users:preferences:update`. Every field is
 * optional — clients may send only the slice they're touching (e.g. just
 * `calorieGoal` after the user moves the slider) without re-sending the
 * full preferences object. The service merges into the existing row.
 *
 * Validation matches the iOS UI bounds:
 *   - calorieGoal: 1200…3500, clamped server-side as a defence in depth
 *   - activityLevel: 1…4 (sedentary → very active), clamped server-side
 *   - allergens: at most 32 unique short strings
 */
export class UpdatePreferencesDto {
  @ApiPropertyOptional({ enum: DietPreferenceValue, example: 'VEGETARIAN' })
  @IsOptional()
  @IsEnum(DietPreferenceValue)
  dietPreference?: DietPreferenceValue;

  @ApiPropertyOptional({ example: 2000, minimum: 1200, maximum: 3500 })
  @IsOptional()
  @IsInt()
  @Min(1200)
  @Max(3500)
  calorieGoal?: number;

  @ApiPropertyOptional({
    example: ['gluten', 'nuts'],
    description: 'Lowercase allergen IDs matching the iOS Allergen enum.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(32)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  allergens?: string[];

  @ApiPropertyOptional({ enum: UserGoal, example: 'HEALTHY' })
  @IsOptional()
  @IsEnum(UserGoal)
  goal?: UserGoal;

  @ApiPropertyOptional({ example: 3, minimum: 1, maximum: 4 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4)
  activityLevel?: number;
}
