import {
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
  RECOVERY_CODE_COUNT,
  recoveryCodeKey,
} from './recovery-codes';

describe('kody odzyskiwania', () => {
  const master = Buffer.alloc(32, 7);

  it('dziesięć różnych kodów w formacie XXXXX-XXXXX, bez mylących znaków', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const code of codes) {
      expect(code).toMatch(/^[2-9A-HJKMNP-Z]{5}-[2-9A-HJKMNP-Z]{5}$/);
      expect(code).not.toMatch(/[01IOL]/);
    }
  });

  it('normalizacja: małe litery, spacje i myślniki nie przeszkadzają', () => {
    const [code] = generateRecoveryCodes(1);
    const bare = code.replace('-', '');
    expect(normalizeRecoveryCode(code)).toBe(bare);
    expect(normalizeRecoveryCode(` ${code.toLowerCase()} `)).toBe(bare);
    expect(normalizeRecoveryCode(bare.split('').join(' '))).toBe(bare);
  });

  it.each([
    ['za krótki', 'ABCDE-FGH'],
    ['znak spoza alfabetu (O)', 'ABCDE-FGHJO'],
    ['nie tekst', 12345],
  ])('odrzuca: %s', (_label, input) => {
    expect(normalizeRecoveryCode(input)).toBeNull();
  });

  it('hasz zależy od klucza — ten sam kod pod innym kluczem to inny hasz', () => {
    const key = recoveryCodeKey(master);
    const other = recoveryCodeKey(Buffer.alloc(32, 8));
    expect(key).toHaveLength(32);
    expect(key.equals(master)).toBe(false);
    expect(hashRecoveryCode('ABCDEFGHJK', key)).toBe(
      hashRecoveryCode('ABCDEFGHJK', key),
    );
    expect(hashRecoveryCode('ABCDEFGHJK', key)).not.toBe(
      hashRecoveryCode('ABCDEFGHJK', other),
    );
    expect(hashRecoveryCode('ABCDEFGHJK', key)).toMatch(/^[0-9a-f]{64}$/);
  });
});
