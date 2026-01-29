import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateRecipeDto {
  @ApiProperty({ example: 'Makaron z pomidorami' })
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  title: string;

  @ApiPropertyOptional({ example: 'Prosty makaron z sosem pomidorowym i bazylią.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsString()
  authorId: string;

  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsString()
  householdId: string;
}
