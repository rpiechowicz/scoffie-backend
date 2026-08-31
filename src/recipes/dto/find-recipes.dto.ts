import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { MealType } from '@prisma/client';
import { MEAL_TYPE_VALUES } from '../../common/meal-types';

const mealTypes = MEAL_TYPE_VALUES;

export const RECIPES_DEFAULT_PAGE_LIMIT = 24;
/**
 * Górna granica strony — ta sama dla dekoratora i klamry w serwisie, żeby
 * `limit` nie przechodził walidacji tylko po to, by serwis po cichu przyciął
 * go do innej liczby. iOS prosi o PEŁNĄ stronę `limit: 100`
 * (`RecipeCatalogStore.pageSize`) — obniżenie tej granicy poniżej 100 to
 * zmiana klienta. Domyślne 24 dotyczy tylko wywołań bez `limit` (asystent
 * in-process).
 */
export const RECIPES_MAX_PAGE_LIMIT = 100;
export const RECIPES_MAX_PAGE = 10_000;

export class FindRecipesDto {
  @ApiPropertyOptional({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsOptional()
  @IsUUID()
  householdId?: string;

  /**
   * Filtr slotu. Dopasowanie idzie po `suitableMealTypes` (a nie po slocie
   * bazowym), więc `mealType=SECOND_BREAKFAST` zwróci m.in. owsiankę, której
   * `mealType` to `BREAKFAST` — o to w tej funkcji chodzi.
   */
  @ApiPropertyOptional({ enum: mealTypes, example: 'DINNER' })
  @IsOptional()
  @IsIn(mealTypes)
  mealType?: MealType;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      if (value.toLowerCase() === 'true') return true;
      if (value.toLowerCase() === 'false') return false;
    }
    return value;
  })
  @IsBoolean()
  isFavorite?: boolean;

  @ApiPropertyOptional({ example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'string') return Number.parseInt(value, 10);
    return value;
  })
  @IsInt()
  @Min(1)
  @Max(RECIPES_MAX_PAGE)
  page?: number;

  @ApiPropertyOptional({
    example: RECIPES_DEFAULT_PAGE_LIMIT,
    minimum: 1,
    maximum: RECIPES_MAX_PAGE_LIMIT,
    default: RECIPES_DEFAULT_PAGE_LIMIT,
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'string') return Number.parseInt(value, 10);
    return value;
  })
  @IsInt()
  @Min(1)
  @Max(RECIPES_MAX_PAGE_LIMIT)
  limit?: number;
}
