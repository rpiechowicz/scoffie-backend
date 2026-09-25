import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export const GOOGLE_SIGN_IN_PLATFORMS = ['android', 'ios'] as const;
export type GoogleSignInPlatform = (typeof GOOGLE_SIGN_IN_PLATFORMS)[number];

/**
 * Logowanie przez Google (Android, Credential Manager → `GetGoogleIdOption`
 * z `serverClientId` = Web client ID z `GOOGLE_OAUTH_CLIENT_IDS`).
 *
 * Profil (imię, adres, zdjęcie) NIE jest przyjmowany z ciała — serwer bierze
 * go wyłącznie z podpisanego tokenu, tak samo jak przy Apple.
 */
export class GoogleSignInDto {
  @ApiProperty({
    description: 'Google ID token (JWT) z Credential Managera.',
    example: 'eyJhbGciOiJSUzI1NiIsImtpZCI6Ij...',
  })
  @IsString()
  @MinLength(10)
  // Token Google ma ~1–1,5 KB; 8 KB to margines, nie zaproszenie do wysyłania
  // nam 100 KB do weryfikacji podpisu (ten sam limit co przy Apple).
  @MaxLength(8192)
  idToken: string;

  @ApiProperty({
    description:
      'Nonce przekazany do `GetGoogleIdOption.setNonce` (surowy, bez haszowania). Gdy podany, musi być równy claimowi `nonce` tokenu.',
    required: false,
    example: 'b3f1c2d4e5a6978812345678',
  })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(512)
  nonce?: string;

  @ApiProperty({
    description: 'Platforma klienta (informacyjnie).',
    required: false,
    enum: GOOGLE_SIGN_IN_PLATFORMS,
    example: 'android',
  })
  @IsOptional()
  @IsIn(GOOGLE_SIGN_IN_PLATFORMS)
  platform?: GoogleSignInPlatform;
}
