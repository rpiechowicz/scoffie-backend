import { createHmac, hkdfSync, randomInt } from 'crypto';

/** Ile kodów wydajemy naraz (ROADMAPA §4: 10 × jednorazowe). */
export const RECOVERY_CODE_COUNT = 10;

/**
 * Alfabet bez znaków mylonych przy przepisywaniu (0/O, 1/I/L) — 31 znaków.
 * Kod ma 10 znaków: 31^10 ≈ 2^49,5 możliwości, przy blokadzie po pięciu
 * nieudanych próbach na kwadrans zgadywanie online nie wchodzi w grę, a
 * offline broni HMAC z kluczem spoza bazy.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 10;

/** `ABCDE-FGHJK` — z myślnikiem do czytania, bez niego do porównań. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    let raw = '';
    for (let i = 0; i < CODE_LENGTH; i++)
      raw += ALPHABET[randomInt(ALPHABET.length)];
    codes.add(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return [...codes];
}

/**
 * Kod z formularza do postaci porównywalnej: wielkie litery, bez spacji
 * i myślników. Znak spoza alfabetu (także pomylone `O` czy `I`) → `null`,
 * bez zgadywania, co autor miał na myśli.
 */
export function normalizeRecoveryCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const clean = input.toUpperCase().replace(/[\s-]/g, '');
  if (clean.length !== CODE_LENGTH) return null;
  for (const char of clean) {
    if (!ALPHABET.includes(char)) return null;
  }
  return clean;
}

/**
 * Klucz HMAC kodów wyprowadzony (HKDF) z `ADMIN_TOTP_ENCRYPTION_KEY` —
 * jeden sekret w env, dwa klucze o rozłącznych zastosowaniach.
 */
export function recoveryCodeKey(masterKey: Buffer): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      masterKey,
      Buffer.alloc(0),
      'scoffie-admin-recovery-codes/v1',
      32,
    ),
  );
}

/** HMAC-SHA256 (hex) znormalizowanego kodu — w bazie leży tylko to. */
export function hashRecoveryCode(normalized: string, key: Buffer): string {
  return createHmac('sha256', key).update(normalized).digest('hex');
}
