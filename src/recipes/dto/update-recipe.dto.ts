import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Difficulty, MealType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  ValidateIf,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { MEAL_TYPE_VALUES } from '../../common/meal-types';
import {
  CreateRecipeIngredientDto,
  RECIPE_DESCRIPTION_MAX,
  RECIPE_IMAGE_URL_MAX,
  RECIPE_INGREDIENTS_MAX,
  RECIPE_PREP_TIME_MAX,
  RECIPE_SERVINGS_MAX,
  RECIPE_STEPS_MAX,
  RECIPE_TITLE_MAX,
  RecipeStepDto,
} from './create-recipe.dto';

const mealTypes = MEAL_TYPE_VALUES;

/**
 * Poprawka istniejącego przepisu gospodarstwa.
 *
 * Wszystkie pola opcjonalne i ruszamy WYŁĄCZNIE te, które przyszły. Typowy
 * wołający — asystent po uwadze użytkownika („za mało czosnku") — poprawia
 * jedną rzecz, a nie przysyła przepisu od nowa; pominięte pole znaczy
 * „zostaw", nie „wyczyść".
 *
 * Wyjątkiem są listy: przysłane składniki albo kroki zastępują poprzednie
 * W CAŁOŚCI. Scalanie po nazwie byłoby zgadywaniem, a obie listy są na tyle
 * krótkie, że przesłanie ich w komplecie nic nie kosztuje. Zmiana składników
 * pociąga przeliczenie makr, alergenów i tagów diet — tak samo jak przy
 * tworzeniu, bo to serwer je liczy, nie klient.
 *
 * Czego NIE da się zmienić: gospodarstwa (przepis nie przenosi się między
 * domami) ani przynależności do katalogu (katalog zasila wyłącznie import).
 * Limity są celowo TE SAME, co przy tworzeniu — rozjazd między nimi znaczyłby,
 * że przepis da się zapisać, ale nie da się go potem poprawić.
 */
export class UpdateRecipeDto {
  /** Gospodarstwo, w kontekście którego działamy — bramka członkostwa. */
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  householdId: string;

  @ApiPropertyOptional({ example: 'Makaron z pomidorami' })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(RECIPE_TITLE_MAX)
  title?: string;

  /** `null` czyści opis; brak pola go nie rusza. */
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(RECIPE_DESCRIPTION_MAX)
  description?: string | null;

  @ApiPropertyOptional({ enum: mealTypes })
  @IsOptional()
  @IsIn(mealTypes)
  mealType?: MealType;

  @ApiPropertyOptional({ enum: mealTypes, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(mealTypes, { each: true })
  suitableMealTypes?: MealType[];

  @ApiPropertyOptional({ enum: Difficulty })
  @IsOptional()
  @IsEnum(Difficulty)
  difficulty?: Difficulty;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(RECIPE_PREP_TIME_MAX)
  prepTimeMinutes?: number;

  @ApiPropertyOptional({ example: 2 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(RECIPE_SERVINGS_MAX)
  servings?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(RECIPE_IMAGE_URL_MAX)
  imageUrl?: string;

  @ApiPropertyOptional({ type: [CreateRecipeIngredientDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(RECIPE_INGREDIENTS_MAX)
  @ValidateNested({ each: true })
  @Type(() => CreateRecipeIngredientDto)
  ingredients?: CreateRecipeIngredientDto[];

  @ApiPropertyOptional({ type: [RecipeStepDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(RECIPE_STEPS_MAX)
  @ValidateNested({ each: true })
  @Type(() => RecipeStepDto)
  steps?: RecipeStepDto[];
}
