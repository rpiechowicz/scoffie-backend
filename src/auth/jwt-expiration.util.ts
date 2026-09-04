import type { JwtService } from '@nestjs/jwt';

type JwtExpiresIn = NonNullable<
  Parameters<JwtService['signAsync']>[1]
>['expiresIn'];

// Godzina, nie 30 dni: logout unieważnia tylko refresh token, więc
// skradziony access token żył dotąd miesiąc. iOS odświeża sam.
const DEFAULT_JWT_EXPIRES_IN: JwtExpiresIn = '1h';

export function resolveJwtExpiresIn(
  rawValue: string | undefined,
): JwtExpiresIn {
  const value = rawValue?.trim();

  if (!value) {
    return DEFAULT_JWT_EXPIRES_IN;
  }

  if (/^\d+$/.test(value)) {
    const numericValue = Number(value);
    if (Number.isSafeInteger(numericValue)) {
      return numericValue;
    }
  }

  return value as JwtExpiresIn;
}
