import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
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

  // Makra przyjmują `null` — to znaczy „przestań trzymać moją wartość
  // i licz za mnie". Bez tego nie dałoby się wrócić do automatu inaczej
  // niż zgadując, którą liczbę uznać za „pustą".
  @ApiPropertyOptional({
    example: 160,
    minimum: 0,
    maximum: 400,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(400)
  proteinG?: number | null;

  @ApiPropertyOptional({
    example: 61,
    minimum: 0,
    maximum: 300,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(300)
  fatG?: number | null;

  @ApiPropertyOptional({
    example: 254,
    minimum: 0,
    maximum: 800,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(800)
  carbsG?: number | null;

  // Kanały powiadomień push. Do tej pory te przełączniki żyły wyłącznie w
  // `UserDefaults` telefonu i wyciszały tylko lokalne bannery — pushe składa
  // serwer, więc bez tych pól „wyłącz powiadomienia" nie wyłączało niczego,
  // co przychodziło z zewnątrz.
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  pushPlanChanges?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  pushShoppingList?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  pushHousehold?: boolean;

  @ApiPropertyOptional({
    example: true,
    description: 'Cisza nocna 22:00–07:00.',
  })
  @IsOptional()
  @IsBoolean()
  pushQuietHours?: boolean;

  // Strefa IANA z telefonu (`TimeZone.current.identifier`). Bez niej cisza
  // nocna liczyłaby się w strefie kontenera, czyli zwykle w UTC.
  @ApiPropertyOptional({ example: 'Europe/Warsaw' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timeZone?: string;
}
