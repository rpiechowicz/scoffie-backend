import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { INGREDIENT_SEARCH_MAX_LIMIT } from '../ingredient-search.util';

export class SearchIngredientsDto {
  /** Nazwa albo jej kawałek; odmiana nie przeszkadza („jajka" trafia w „jajko"). */
  @ApiPropertyOptional({ example: 'pierś z kurczaka' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  query?: string;

  /** Kategoria katalogu, np. „Warzywa". Bez zapytania działa jak przeglądanie. */
  @ApiPropertyOptional({ example: 'Warzywa' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

  /**
   * Tylko składniki z wartościami odżywczymi.
   *
   * Ma znaczenie praktyczne: dwie trzecie katalogu nie ma jeszcze makro, a bez
   * niego przepis nie przejdzie zapisu. Asystent układający nowy przepis
   * powinien pytać z tą flagą, żeby nie proponować czegoś, co i tak zostanie
   * odrzucone.
   */
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  onlyWithNutrition?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: INGREDIENT_SEARCH_MAX_LIMIT })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(INGREDIENT_SEARCH_MAX_LIMIT)
  limit?: number;
}
