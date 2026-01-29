import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class GoogleOauthDto {
  @ApiProperty({ example: '4/0AfJohXl9...' })
  @IsString()
  @MinLength(6)
  code: string;

  @ApiProperty({ example: 's256-code-verifier-from-frontend' })
  @IsString()
  @MinLength(16)
  codeVerifier: string;

  @ApiProperty({ example: 'http://localhost:5173/auth/callback/google' })
  @IsString()
  @MinLength(10)
  redirectUri: string;
}
