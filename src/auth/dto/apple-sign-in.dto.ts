import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Request payload from iOS Sign in with Apple.
 *
 * iOS flow:
 *  1. Generate a random `rawNonce` (32+ bytes, hex/base64).
 *  2. Request sign-in with `SHA256(rawNonce)` set on `ASAuthorizationAppleIDRequest.nonce`.
 *  3. Send the resulting `identityToken` (JWT), the *raw* nonce, and any optional
 *     profile fields Apple returns on FIRST sign-in (fullName/email) to this endpoint.
 */
export class AppleSignInDto {
  @ApiProperty({
    description:
      'Apple identityToken (JWT) returned by ASAuthorizationAppleIDCredential.',
    example: 'eyJraWQiOiJXNldjT0tCIi...',
  })
  @IsString()
  @MinLength(10)
  // Prawdziwy token Apple ma około 1 KB; 8 KB to margines na przyszłe claimy,
  // a nie zaproszenie do wysyłania nam 100 KB do weryfikacji podpisu.
  @MaxLength(8192)
  identityToken: string;

  @ApiProperty({
    description:
      'The raw (pre-SHA256) nonce the client generated. Apple stores sha256(rawNonce) in the JWT.',
    example: 'A6JxLp9X5pKlRZ1uG3Q0t2HvZs6mW7c4Y9sBvUeQpnE=',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(512)
  rawNonce: string;

  @ApiProperty({
    description:
      'First name returned by Apple (only on very first sign-in per Apple ID).',
    required: false,
    example: 'Rafał',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  givenName?: string;

  @ApiProperty({
    description:
      'Last name returned by Apple (only on very first sign-in per Apple ID).',
    required: false,
    example: 'Piechowicz',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  familyName?: string;

  @ApiProperty({
    description:
      'Email returned by Apple on first sign-in. Accepted for compatibility and IGNORED: the stored address comes only from the verified identity token.',
    required: false,
    example: 'rafal@example.com',
  })
  @IsOptional()
  @IsEmail()
  email?: string;
}
