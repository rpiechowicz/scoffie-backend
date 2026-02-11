import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';

const mealTypes = ['BREAKFAST', 'LUNCH', 'DINNER'] as const;

export class FindRecipesDto {
  @ApiPropertyOptional({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsOptional()
  @IsString()
  householdId?: string;

  @ApiPropertyOptional({ enum: mealTypes, example: 'DINNER' })
  @IsOptional()
  @IsIn(mealTypes)
  mealType?: (typeof mealTypes)[number];

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
}
