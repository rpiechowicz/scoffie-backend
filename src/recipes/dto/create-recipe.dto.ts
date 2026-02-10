import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  Min,
  ValidateNested,
} from 'class-validator';

const mealTypes = ['BREAKFAST', 'LUNCH', 'DINNER'] as const;
const difficulties = ['EASY', 'MEDIUM', 'HARD'] as const;

export class CreateRecipeIngredientDto {
  @ApiProperty({ example: 'Pomidor' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @ApiProperty({ example: 250 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amount: number;

  @ApiProperty({ example: 'g' })
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  unit: string;

  @ApiProperty({ example: 'Warzywa' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  department: string;
}

export class CreateRecipeDto {
  @ApiProperty({ example: 'Makaron z pomidorami' })
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  title: string;

  @ApiPropertyOptional({ example: 'Prosty makaron z sosem pomidorowym i bazylią.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ enum: mealTypes })
  @IsIn(mealTypes)
  mealType: (typeof mealTypes)[number];

  @ApiProperty({ enum: difficulties, example: 'EASY' })
  @IsIn(difficulties)
  difficulty: (typeof difficulties)[number];

  @ApiProperty({ example: 20 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  prepTimeMinutes: number;

  @ApiProperty({ example: 2 })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  servings: number;

  @ApiPropertyOptional({ example: 'https://images.unsplash.com/photo-1510693206972-df098062cb71?w=800&q=80' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  imageUrl?: string;

  @ApiPropertyOptional({ example: 520 })
  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  @Min(0)
  nutritionKcal?: number;

  @ApiPropertyOptional({ example: 32 })
  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  @Min(0)
  nutritionProtein?: number;

  @ApiPropertyOptional({ example: 38 })
  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  @Min(0)
  nutritionFat?: number;

  @ApiPropertyOptional({ example: 8 })
  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  @Min(0)
  nutritionCarbs?: number;

  @ApiPropertyOptional({ example: 2 })
  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  @Min(0)
  nutritionFiber?: number;

  @ApiPropertyOptional({ example: 2 })
  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  @Min(0)
  nutritionSalt?: number;

  @ApiPropertyOptional({ type: [CreateRecipeIngredientDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateRecipeIngredientDto)
  ingredients?: CreateRecipeIngredientDto[];

  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsString()
  householdId: string;
}
