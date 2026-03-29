import type { SignOptions } from 'jsonwebtoken';

const DEFAULT_JWT_EXPIRES_IN: SignOptions['expiresIn'] = '30d';

export function resolveJwtExpiresIn(
  rawValue: string | undefined,
): SignOptions['expiresIn'] {
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

  return value as SignOptions['expiresIn'];
}
