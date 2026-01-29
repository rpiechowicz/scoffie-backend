import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateHouseholdDto {
  @ApiProperty({ example: 'Home' })
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  name: string;
}
