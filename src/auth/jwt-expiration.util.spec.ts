import { JwtService } from '@nestjs/jwt';
import { jwtExpiresInSeconds } from './jwt-expiration.util';

// Parytet z tym, co naprawdę podpisuje `JwtService` (jsonwebtoken + ms):
// assert-env ostrzega o długim tokenie, więc musi liczyć czas tak samo.
describe('jwtExpiresInSeconds', () => {
  const jwt = new JwtService({ secret: 'x'.repeat(40) });

  const signedLifetime = (expiresIn: string | number): number | null => {
    try {
      const token = jwt.sign({}, { expiresIn: expiresIn as never });
      const { exp, iat } = jwt.decode<{ exp: number; iat: number }>(token);
      return exp - iat;
    } catch {
      return null;
    }
  };

  it.each([
    '1h',
    '30d',
    '3600',
    '90',
    '15m',
    '15 minutes',
    '2 hrs',
    '1.5h',
    '1w',
    '1y',
    '1H',
    '120000ms',
    '1.5',
  ])('%p — tyle samo sekund co w podpisanym tokenie', (raw) => {
    const seconds = jwtExpiresInSeconds(raw);
    expect(seconds).not.toBeNull();
    // Podpisane `iat`/`exp` są całkowite, a `ms` potrafi dać ułamek.
    const resolved = /^\d+$/.test(raw) ? Number(raw) : raw;
    expect(Math.floor(seconds as number)).toBe(signedLifetime(resolved));
  });

  it('brak zmiennej = domyślna godzina', () => {
    expect(jwtExpiresInSeconds(undefined)).toBe(3600);
    expect(jwtExpiresInSeconds('  ')).toBe(3600);
  });

  it.each(['abc', '1 fortnight', '1h30m', 'h'])(
    '%p — null, bo jsonwebtoken też go nie przyjmie',
    (raw) => {
      expect(jwtExpiresInSeconds(raw)).toBeNull();
      expect(signedLifetime(raw)).toBeNull();
    },
  );
});
