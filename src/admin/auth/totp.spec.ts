import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  matchTotpStep,
  normalizeTotpCode,
  otpauthUrl,
  totpCode,
  totpStep,
} from './totp';

// RFC 6238, dodatek B: sekret ASCII „12345678901234567890", SHA-1. Wektory
// mają 8 cyfr — sześć ostatnich to kod z Google Authenticatora.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
const RFC_VECTORS: [number, string][] = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

describe('TOTP', () => {
  it.each(RFC_VECTORS)('wektor RFC 6238 dla T=%i → %s', (seconds, code) => {
    expect(totpCode(RFC_SECRET, totpStep(seconds * 1000))).toBe(code);
  });

  it('HOTP z RFC 4226 (licznik 0 i 9)', () => {
    const key = Buffer.from('12345678901234567890', 'ascii');
    expect(hotp(key, 0)).toBe('755224');
    expect(hotp(key, 9)).toBe('520489');
  });

  it('base32 w obie strony, także bez paddingu i małymi literami', () => {
    const data = Buffer.from('panel admina scoffie');
    const text = base32Encode(data);
    expect(base32Decode(text)).toEqual(data);
    expect(base32Decode(text.toLowerCase())).toEqual(data);
    expect(() => base32Decode('01!')).toThrow();
  });

  it('sekret ma 160 bitów (32 znaki base32) i jest losowy', () => {
    const a = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateTotpSecret()).not.toBe(a);
  });

  describe('okno ±1 i brak powtórki kroku', () => {
    const secret = generateTotpSecret();
    const now = Date.UTC(2026, 8, 24, 12, 0, 10);
    const step = totpStep(now);

    it('przyjmuje kod bieżący, poprzedni i następny', () => {
      for (const offset of [0, -1, 1]) {
        expect(
          matchTotpStep(secret, totpCode(secret, step + offset), now, null),
        ).toBe(step + offset);
      }
    });

    it('odrzuca kod sprzed dwóch kroków i z dwóch kroków naprzód', () => {
      expect(
        matchTotpStep(secret, totpCode(secret, step - 2), now, null),
      ).toBeNull();
      expect(
        matchTotpStep(secret, totpCode(secret, step + 2), now, null),
      ).toBeNull();
    });

    it('ten sam krok drugi raz NIE przechodzi — nawet w swoim oknie', () => {
      const code = totpCode(secret, step);
      expect(matchTotpStep(secret, code, now, null)).toBe(step);
      // Po przejęciu kroku `lastUsedStep = step` — ten sam kod odpada…
      expect(matchTotpStep(secret, code, now, step)).toBeNull();
      // …a także kod z kroku poprzedniego (starszy niż przyjęty).
      expect(
        matchTotpStep(secret, totpCode(secret, step - 1), now, step),
      ).toBeNull();
      // Następny krok działa normalnie.
      expect(matchTotpStep(secret, totpCode(secret, step + 1), now, step)).toBe(
        step + 1,
      );
    });

    it('zły kod, zła długość, litery — null', () => {
      const wrong = String(
        (Number(totpCode(secret, step)) + 1) % 1_000_000,
      ).padStart(6, '0');
      expect(matchTotpStep(secret, wrong, now, null)).toBeNull();
      expect(matchTotpStep(secret, '12345', now, null)).toBeNull();
      expect(matchTotpStep(secret, 'abcdef', now, null)).toBeNull();
    });
  });

  it('kod z odstępem albo myślnikiem jest normalizowany', () => {
    expect(normalizeTotpCode('123 456')).toBe('123456');
    expect(normalizeTotpCode('123-456')).toBe('123456');
    expect(normalizeTotpCode(123456)).toBeNull();
  });

  it('otpauth URL w formacie Google Authenticatora', () => {
    const url = otpauthUrl({
      secret: 'JBSWY3DPEHPK3PXP',
      issuer: 'Scoffie Admin',
      account: 'rafal@example.com',
    });
    expect(url).toBe(
      'otpauth://totp/Scoffie%20Admin:rafal%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Scoffie+Admin&algorithm=SHA1&digits=6&period=30',
    );
  });
});
