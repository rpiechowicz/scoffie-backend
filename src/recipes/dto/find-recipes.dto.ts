import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { MealType } from '@prisma/client';
import { MEAL_TYPE_VALUES } from '../../common/meal-types';

const mealTypes = MEAL_TYPE_VALUES;

export class FindRecipesDto {
  @ApiPropertyOptional({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsOptional()
  @IsString()
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
  page?: number;

  @ApiPropertyOptional({ example: 24, minimum: 1, maximum: 100, default: 24 })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'string') return Number.parseInt(value, 10);
    return value;
  })
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
