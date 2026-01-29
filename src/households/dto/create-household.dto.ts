import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateHouseholdDto {
  @ApiProperty({ example: 'Home' })
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  name: string;

  @ApiProperty({ required: false, example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsOptional()
  @IsString()
  createdById?: string;
}
