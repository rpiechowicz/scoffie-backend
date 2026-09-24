import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Ciała żądań logowania do panelu. Globalny `ValidationPipe` ma
 * `forbidNonWhitelisted`, więc każde pole musi mieć tu dekorator; odpowiedzi
 * WebAuthn przechodzą jako zwykłe obiekty (`@IsObject`), a ich zawartość
 * sprawdza `@simplewebauthn/server` razem z podpisem.
 */

/** Kod z Google Authenticator albo kod odzyskiwania (`ABCDE-FGHJK`). */
export class AdminCodeDto {
  @IsString()
  @MaxLength(32)
  code!: string;
}

export class AdminPasskeyLoginDto {
  @IsObject()
  response!: AuthenticationResponseJSON;
}

export class AdminPasskeyRegisterOptionsDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;
}

export class AdminPasskeyRegisterDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @IsObject()
  response!: RegistrationResponseJSON;
}

/** Potwierdzenie przed groźną akcją: passkeyem ALBO kodem TOTP. */
export class AdminStepUpDto {
  @IsOptional()
  @IsObject()
  passkey?: AuthenticationResponseJSON;

  @IsOptional()
  @IsString()
  @MaxLength(12)
  totp?: string;
}
