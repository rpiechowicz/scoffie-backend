import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class DevLoginDto {
  @ApiProperty({ example: 'Rafał Piechowicz' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  displayName: string;

  @ApiProperty({ example: 'rafal@example.com', required: false })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiProperty({ example: 'Home', required: false })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  householdName?: string;
}
