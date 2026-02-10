import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateHouseholdDto {
  @ApiProperty({ example: 'My Family Home' })
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  name: string;
}

