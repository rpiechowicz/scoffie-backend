import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { MEAL_TYPE_VALUES } from '../../common/meal-types';
import { ALLOWED_UNITS } from '../../recipes/ingredient-amount.util';

/** `GET /admin/catalog/recipes?active=true|false` — bez parametru cały katalog. */
export class CatalogRecipesQueryDto {
  @IsOptional()
  @IsIn(['true', 'false'])
  active?: 'true' | 'false';
}

/** `POST /admin/catalog/recipes/:id/active` — wycofanie albo przywrócenie z powodem. */
export class RecipeActiveDto {
  @IsBoolean()
  isActive!: boolean;

  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}

const NOT_BLANK = /\S/;

/** Linia składnika w edytorze: `key` = `Ingredient.normalizedName`. */
export class RecipeIngredientLineDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  key!: string;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive()
  @Max(100_000)
  amount!: number;

  @IsIn([...ALLOWED_UNITS])
  unit!: string;
}

/**
 * `PUT /admin/catalog/recipes/:id` — ciało to `RecipeDetail` z edytora
 * (panel wysyła cały obiekt, który dostał z `GET`, z poprawkami).
 *
 * Zapisuje się: tytuł, opis, pora bazowa, sloty, trudność, czas, porcje,
 * kroki i składniki. Makro, alergeny i tagi diet liczy serwer ze składników
 * (te same funkcje, co import katalogu). Pola tylko do odczytu (`isActive`,
 * `kcalPerServing`, `inPlans`, `favorites`, `allergens`, `dietTags`) są
 * przyjmowane i POMIJANE — `forbidNonWhitelisted` odrzuciłby inaczej każdy
 * zapis z panelu. Wycofanie idzie osobną trasą (`…/active`), a zdjęcie —
 * gdy powstanie upload do R2; zmiana `imageUrl` to dziś 400.
 *
 * `updatedAt` (z `GET`) jest WYMAGANE: to strażnik współbieżności — przepis
 * zmieniony w międzyczasie (druga karta, import) daje 409 `CONFLICT`.
 */
export class UpdateCatalogRecipeDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsString()
  @Matches(NOT_BLANK, { message: 'title nie może być pusty' })
  @MaxLength(200)
  title!: string;

  @IsString()
  @MaxLength(2_000)
  description!: string;

  @IsIn(MEAL_TYPE_VALUES)
  mealType!: string;

  @IsArray()
  @ArrayMaxSize(MEAL_TYPE_VALUES.length)
  @ArrayUnique()
  @IsIn(MEAL_TYPE_VALUES, { each: true })
  suitableMealTypes!: string[];

  @IsIn(['EASY', 'MEDIUM', 'HARD'])
  difficulty!: 'EASY' | 'MEDIUM' | 'HARD';

  @IsInt()
  @Min(1)
  @Max(1_440)
  prepTimeMinutes!: number;

  // Porcje = na ile osób napisany jest przepis — ten sam zakres co import.
  @IsInt()
  @Min(1)
  @Max(8)
  servings!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(40)
  @IsString({ each: true })
  @Matches(NOT_BLANK, { each: true, message: 'pusty krok' })
  @MaxLength(2_000, { each: true })
  steps!: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => RecipeIngredientLineDto)
  ingredients!: RecipeIngredientLineDto[];

  @IsISO8601({ strict: true })
  updatedAt!: string;

  // ——— tylko do odczytu: przyjmowane i pomijane ———

  @IsOptional()
  @IsString()
  @MaxLength(2_048)
  imageUrl?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsNumber()
  kcalPerServing?: number;

  @IsOptional()
  @IsInt()
  inPlans?: number;

  @IsOptional()
  @IsInt()
  favorites?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allergens?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  dietTags?: string[];
}
