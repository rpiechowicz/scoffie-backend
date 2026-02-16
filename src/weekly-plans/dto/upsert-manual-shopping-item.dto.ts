import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

const manualShoppingUnits = ['g', 'kg', 'ml', 'l', 'szt'] as const;

export class UpsertManualShoppingItemDto {
  @ApiProperty({ example: 'woda' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @ApiProperty({ example: 2.5 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  amount: number;

  @ApiProperty({ enum: manualShoppingUnits, example: 'l' })
  @IsIn(manualShoppingUnits)
  unit: (typeof manualShoppingUnits)[number];

  @ApiPropertyOptional({ example: 'Napoje' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  department?: string;
}
