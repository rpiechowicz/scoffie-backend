import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class GoogleOauthDto {
  @ApiProperty({ example: 'google-1234567890' })
  @IsString()
  @MinLength(3)
  googleId: string;

  @ApiProperty({ example: 'Rafi' })
  @IsString()
  @MinLength(2)
  displayName: string;

  @ApiProperty({ example: 'rafi@example.com', required: false })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({
    example: 'https://lh3.googleusercontent.com/a/avatar',
    required: false,
  })
  @IsOptional()
  @IsString()
  avatarUrl?: string;
}
