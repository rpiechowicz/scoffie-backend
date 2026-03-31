import type { JwtService } from '@nestjs/jwt';

type JwtExpiresIn = NonNullable<Parameters<JwtService['signAsync']>[1]>['expiresIn'];

const DEFAULT_JWT_EXPIRES_IN: JwtExpiresIn = '30d';

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
