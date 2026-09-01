import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { DietPreferenceValue, UserGoal } from '@prisma/client';
import { ALLERGEN_IDS, ALLERGEN_ID_VALUES } from '../../common/allergens';

/**
 * Partial-update payload for `users:preferences:update`. Every field is
 * optional — clients may send only the slice they're touching (e.g. just
 * `calorieGoal` after the user moves the slider) without re-sending the
 * full preferences object. The service merges into the existing row.
 *
 * Od Fazy 0 dekoratory działają także na WebSockecie: `UsersService.
 * updatePreferences` woła `validateDto(UpdatePreferencesDto)` na wejściu,
 * więc zły enum (`dietPreference: 'vegan'`), string zamiast booleana
 * (`pushPlanChanges: 'true'`) albo liczba spoza zakresu kończą się
 * VALIDATION_ERROR z listą dozwolonych, a nie 500 z Prismy.
 *
 * Validation matches the iOS UI bounds:
 *   - dietPreference / goal: enumy Prismy (jedno źródło prawdy z bazą)
 *   - calorieGoal: 1200…3500, clamped server-side as a defence in depth
 *   - activityLevel: 1…4 (sedentary → very active), clamped server-side
 *   - allergens: at most 32 ids from ALLERGEN_IDS; the service additionally
 *     runs `normalizeAllergenIds` (sort + dedup, defence in depth)
 *   - proteinG/fatG/carbsG: 0..400/300/800 or null; `clampMacro` in the
 *     service stays as defence in depth
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
    enum: ALLERGEN_ID_VALUES,
    isArray: true,
    description:
      'Lowercase allergen IDs matching the iOS Allergen enum. ' +
      'Nieznane id to VALIDATION_ERROR calego zapisu (lista dozwolonych w ' +
      'details); serwis dodatkowo sortuje i deduplikuje (normalizeAllergenIds).',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(32)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  @IsIn(ALLERGEN_IDS, { each: true })
  allergens?: string[];

  /**
   * Czego ten domownik nie je, choć nie jest to alergia.
   *
   * Identyfikatory składników, nie nazwy: „pieczarki" i „pieczarka" to dla
   * bazy dwie różne rzeczy, a lista po nazwach rozjechałaby się przy
   * pierwszej korekcie katalogu. Pusta tablica kasuje wykluczenia.
   */
  @ApiPropertyOptional({ type: [String], format: 'uuid' })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(40)
  @IsUUID('4', { each: true })
  excludedIngredientIds?: string[];

  /**
   * Ile minut najwyżej ma zajmować gotowanie; `null` kasuje ograniczenie.
   *
   * To podpowiedź dla asystenta, nie bramka w walidatorze planu — niedzielna
   * pieczeń ma prawo trwać dłużej.
   */
  @ApiPropertyOptional({ example: 30, minimum: 5, maximum: 240, nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(5)
  @Max(240)
  maxPrepTimeMinutes?: number | null;

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
