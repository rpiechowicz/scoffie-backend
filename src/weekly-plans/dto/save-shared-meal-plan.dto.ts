import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';

export class SaveSharedMealPlanDto {
  @ApiProperty({
    type: [String],
    required: false,
    example: ['3fa85f64-5717-4562-b3fc-2c963f66afa6'],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  breakfastRecipeIds?: string[];

  @ApiProperty({
    type: [String],
    required: false,
    example: ['3fa85f64-5717-4562-b3fc-2c963f66afa6'],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  lunchRecipeIds?: string[];

  @ApiProperty({
    type: [String],
    required: false,
    example: ['3fa85f64-5717-4562-b3fc-2c963f66afa6'],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  dinnerRecipeIds?: string[];
}
