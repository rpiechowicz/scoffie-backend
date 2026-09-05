import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
// Bez `@Type(() => Number)` na polach liczbowych: class-transformer robiłby
// `Number(value)` PRZED walidacją, więc `true` → 1, `[30]` → 30, `'520'` → 520
// przechodziły `@IsInt` po cichu. JSON niesie liczby natywnie (iOS, HTTP);
// wejście asystenta ma być odrzucane, nie „naprawiane".
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  IsUrl,
  Max,
  MaxLength,
  MinLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Difficulty, MealType } from '@prisma/client';
import { MEAL_TYPE_VALUES } from '../../common/meal-types';
import { ALLOWED_UNITS } from '../ingredient-amount.util';

const mealTypes = MEAL_TYPE_VALUES;
// Jedno źródło prawdy dla jednostek: ta sama lista, którą sprawdza
// normalizator ilości i importer katalogu. DTO miało własną kopię — po
// pierwszej korekcie w utilu walidator i normalizator rozjechałyby się.
const ingredientUnits = [...ALLOWED_UNITS];

/** Górne granice: chronią bazę i asystenta przed absurdem, nie przed kuchnią. */
export const RECIPE_TITLE_MAX = 200;
export const RECIPE_DESCRIPTION_MAX = 4000;
export const RECIPE_IMAGE_URL_MAX = 2048;
/** Zdjęcie przepisu: pełny adres https (bez `http:`, `javascript:`, hostów bez domeny). */
export const RECIPE_IMAGE_URL_OPTIONS = {
  protocols: ['https'],
  require_protocol: true,
  require_tld: true,
};
export const RECIPE_INGREDIENTS_MAX = 60;
/** Przepisy użytkownika bywają na więcej porcji niż katalogowe 1..8. */
export const RECIPE_SERVINGS_MAX = 20;
/** Tydzień w minutach — marynaty i fermentacje trwają dniami, nie miesiącami. */
export const RECIPE_PREP_TIME_MAX = 7 * 24 * 60;
export const INGREDIENT_AMOUNT_MAX = 100_000;
/** Kroki przygotowania: sufit na długość listy i pojedynczy krok. */
export const RECIPE_STEPS_MAX = 40;
export const RECIPE_STEP_TEXT_MAX = 1000;
export const NUTRITION_VALUE_MAX = 100_000;

export class CreateRecipeIngredientDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsUUID()
  ingredientId: string;

  @ApiProperty({ example: 250 })
  @IsNumber()
  @IsPositive()
  @Max(INGREDIENT_AMOUNT_MAX)
  amount: number;

  @ApiProperty({ enum: ingredientUnits, example: 'g' })
  @IsIn(ingredientUnits)
  unit: string;
}

/**
 * Jeden krok przygotowania.
 *
 * `stepNumber` jest opcjonalny i służy WYŁĄCZNIE do ustalenia kolejności —
 * numery i tak nadajemy od nowa (`normalizeRecipeSteps`), żeby „1, 2, 2, 5"
 * od modelu nie zapisało się jako przepis z duplikatem i dziurą.
 */
export class RecipeStepDto {
  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(RECIPE_STEPS_MAX)
  stepNumber?: number;

  @ApiProperty({ example: 'Podsmaż cebulę na oliwie.' })
  @IsString()
  @MinLength(1)
  @MaxLength(RECIPE_STEP_TEXT_MAX)
  text: string;
}

export class CreateRecipeDto {
  @ApiProperty({ example: 'Makaron z pomidorami' })
  @IsString()
  @MinLength(3)
  @MaxLength(RECIPE_TITLE_MAX)
  title: string;

  @ApiPropertyOptional({
    example: 'Prosty makaron z sosem pomidorowym i bazylią.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(RECIPE_DESCRIPTION_MAX)
  description?: string;

  /** Slot bazowy — jeden, steruje sekcją i okładką na liście przepisów. */
  @ApiProperty({ enum: mealTypes })
  @IsIn(mealTypes)
  mealType: MealType;

  /**
   * Pozostałe sloty, w których danie ma sens („ta owsianka jest też na
   * II śniadanie"). Slot bazowy dokłada serwis, więc klient nie musi go tu
   * powtarzać. Pominięcie pola = tylko slot bazowy.
   */
  @ApiPropertyOptional({
    enum: mealTypes,
    isArray: true,
    example: ['SECOND_BREAKFAST'],
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(6)
  @IsIn(mealTypes, { each: true })
  suitableMealTypes?: MealType[];

  // Enum Prismy zamiast lokalnej listy: komunikat błędu wymienia dozwolone
  // wartości, a nowa trudność w schemacie nie wymaga drugiej kopii tutaj.
  @ApiProperty({ enum: Object.values(Difficulty), example: 'EASY' })
  @IsEnum(Difficulty)
  difficulty: Difficulty;

  @ApiProperty({ example: 20 })
  @IsInt()
  @Min(1)
  @Max(RECIPE_PREP_TIME_MAX)
  prepTimeMinutes: number;

  @ApiProperty({ example: 2 })
  @IsInt()
  @Min(1)
  @Max(RECIPE_SERVINGS_MAX)
  servings: number;

  @ApiPropertyOptional({
    example:
      'https://images.unsplash.com/photo-1510693206972-df098062cb71?w=800&q=80',
  })
  @IsOptional()
  @IsString()
  @MaxLength(RECIPE_IMAGE_URL_MAX)
  // Adres wraca do WSZYSTKICH domowników i ładuje go telefon: tylko https,
  // żeby nie dało się wpisać `javascript:`, adresu w sieci wewnętrznej ani
  // piksela śledzącego po jawnym http.
  @IsUrl(RECIPE_IMAGE_URL_OPTIONS)
  imageUrl?: string;

  @ApiPropertyOptional({ example: 520 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(NUTRITION_VALUE_MAX)
  nutritionKcal?: number;

  @ApiPropertyOptional({ example: 32 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(NUTRITION_VALUE_MAX)
  nutritionProtein?: number;

  @ApiPropertyOptional({ example: 38 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(NUTRITION_VALUE_MAX)
  nutritionFat?: number;

  @ApiPropertyOptional({ example: 8 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(NUTRITION_VALUE_MAX)
  nutritionCarbs?: number;

  @ApiPropertyOptional({ example: 2 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(NUTRITION_VALUE_MAX)
  nutritionFiber?: number;

  @ApiPropertyOptional({ example: 2 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(NUTRITION_VALUE_MAX)
  /** Sól DODANA w gramach (szczypta ≈ 0,3 g, łyżeczka ≈ 6 g); sól ze składników liczy serwer z sodu. */
  nutritionSalt?: number;

  @ApiPropertyOptional({ type: [CreateRecipeIngredientDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(RECIPE_INGREDIENTS_MAX)
  @ValidateNested({ each: true })
  @Type(() => CreateRecipeIngredientDto)
  ingredients?: CreateRecipeIngredientDto[];

  /**
   * Kroki przygotowania. Do Fazy 1 dało się je wgrać wyłącznie importem
   * katalogu, więc asystent potrafił zaproponować danie, ale nie umiał
   * zapisać, jak je ugotować.
   */
  @ApiPropertyOptional({ type: [RecipeStepDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(RECIPE_STEPS_MAX)
  @ValidateNested({ each: true })
  @Type(() => RecipeStepDto)
  steps?: RecipeStepDto[];

  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsUUID()
  householdId: string;
}
