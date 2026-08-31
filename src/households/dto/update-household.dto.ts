import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/** Te same granice co przy tworzeniu — patrz `CreateHouseholdDto`. */
export class UpdateHouseholdDto {
  @ApiProperty({ example: 'My Family Home', minLength: 2, maxLength: 64 })
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  name: string;
}
