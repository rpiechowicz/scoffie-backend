import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class DevLoginDto {
  @ApiProperty({ example: 'Rafał Piechowicz' })
  @IsString()
  @MinLength(2)
  displayName: string;

  @ApiProperty({ example: 'rafal@example.com', required: false })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ example: 'Home', required: false })
  @IsOptional()
  @IsString()
  @MinLength(2)
  householdName?: string;
}
