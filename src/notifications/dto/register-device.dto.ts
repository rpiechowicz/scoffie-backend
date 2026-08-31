import { PushPlatform } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Co klient MOŻE wpisać w `apnsEnvironment`. Szersze niż `ApnsEnvironment`
 * (`SANDBOX` | `PRODUCTION`), bo iOS z Xcode zgłasza się też jako
 * `DEVELOPMENT` (nazwa z entitlementu `aps-environment`); na `SANDBOX`
 * sprowadza to `parseApnsEnvironment` w serwisie — jedno miejsce mapowania.
 */
export const APNS_ENVIRONMENT_INPUTS = [
  'SANDBOX',
  'DEVELOPMENT',
  'PRODUCTION',
] as const;

export type ApnsEnvironmentInput = (typeof APNS_ENVIRONMENT_INPUTS)[number];

/**
 * `data` zdarzenia `notifications:registerDevice`. Waliduje serwis
 * (`validateDto`), więc te same reguły chronią WebSocket i wywołania
 * in-process asystenta. Bez walidacji: liczba w `deviceToken` kończyła się
 * `token.replace is not a function` → 500, a `platform: 'ANDROID'` wywracał
 * Prismę na enumie.
 */
export class RegisterDeviceDto {
  /** Hex tokenu APNs (64 znaki), ale przyjmujemy też format z `<>`/spacjami — serwis normalizuje. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  deviceToken: string;

  @IsOptional()
  @IsEnum(PushPlatform)
  platform?: PushPlatform;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  appBundleId?: string;

  /**
   * Wielkość liter bez znaczenia (`sandbox` z pierwszych buildów iOS nadal
   * przechodzi) — normalizacja przed `@IsIn`, żeby komunikat błędu niósł
   * listę dozwolonych, a nie odrzucał poprawnej wartości w innym zapisie.
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn(APNS_ENVIRONMENT_INPUTS)
  apnsEnvironment?: ApnsEnvironmentInput;
}
