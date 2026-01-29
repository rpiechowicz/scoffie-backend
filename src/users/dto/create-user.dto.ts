import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateUserDto {
  @ApiProperty({ example: 'google', enum: ['google', 'apple'] })
  @IsIn(['google', 'apple'])
  provider: 'google' | 'apple';

  @ApiProperty({ example: 'google-anna' })
  @IsString()
  @MinLength(3)
  @MaxLength(128)
  providerId: string;

  @ApiProperty({ example: 'Anna Nowak' })
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  displayName: string;

  @ApiPropertyOptional({ example: 'https://i.pravatar.cc/150?img=47' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  avatarUrl?: string;
}
