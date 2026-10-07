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

// Jednostki biblioteki `ms` (2.x), przez którą `jsonwebtoken` czyta napis
// `expiresIn` — w sekundach. Rok to 365,25 dnia, jak w `ms`.
const MS_UNIT_SECONDS: Record<string, number> = {
  ms: 0.001,
  s: 1,
  m: 60,
  h: 3600,
  d: 86_400,
  w: 604_800,
  y: 31_557_600,
};
const MS_UNIT_ALIASES: Record<string, keyof typeof MS_UNIT_SECONDS> = {
  milliseconds: 'ms',
  millisecond: 'ms',
  msecs: 'ms',
  msec: 'ms',
  ms: 'ms',
  seconds: 's',
  second: 's',
  secs: 's',
  sec: 's',
  s: 's',
  minutes: 'm',
  minute: 'm',
  mins: 'm',
  min: 'm',
  m: 'm',
  hours: 'h',
  hour: 'h',
  hrs: 'h',
  hr: 'h',
  h: 'h',
  days: 'd',
  day: 'd',
  d: 'd',
  weeks: 'w',
  week: 'w',
  w: 'w',
  years: 'y',
  year: 'y',
  yrs: 'y',
  yr: 'y',
  y: 'y',
};

/**
 * Ile sekund żyje token dostępu przy danym `JWT_EXPIRES_IN` — tą samą drogą,
 * co przy podpisie: liczba z `resolveJwtExpiresIn` to sekundy, napis czyta
 * `ms` (gołe „1.5” bez jednostki to dla niego MILISEKUNDY). `null` = napis,
 * którego `jsonwebtoken` nie przyjmie (podpis tokenu by się wywrócił).
 */
export function jwtExpiresInSeconds(
  rawValue: string | undefined,
): number | null {
  const resolved = resolveJwtExpiresIn(rawValue);
  if (typeof resolved === 'number') return resolved;
  const text = String(resolved);
  if (text.length > 100) return null;
  const match =
    /^(-?(?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i.exec(
      text,
    );
  if (!match) return null;
  const unit = MS_UNIT_ALIASES[(match[2] ?? 'ms').toLowerCase()];
  return parseFloat(match[1]) * MS_UNIT_SECONDS[unit];
}
