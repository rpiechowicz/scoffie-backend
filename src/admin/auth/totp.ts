import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * TOTP (RFC 6238 na HOTP z RFC 4226): SHA-1, 6 cyfr, krok 30 s — dokładnie
 * to, co bez żadnych ustawień rozumie Google Authenticator.
 *
 * Własna implementacja zamiast biblioteki, bo to trzydzieści linii czystej
 * arytmetyki na `crypto` z Node, sprawdzonych wektorami z RFC
 * (`totp.spec.ts`), a biblioteki TOTP zmieniały ostatnio API i format
 * modułów. Mniej zależności na ścieżce logowania do panelu = mniej miejsc,
 * w których aktualizacja cicho zmienia zachowanie.
 */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Okno: bieżący krok ±1 (zegar telefonu spóźniony albo przyspieszony o ≤30 s). */
export const TOTP_WINDOW = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('niepoprawny znak base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 20 losowych bajtów (160 bitów, zalecenie RFC 4226) jako base32. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** HOTP(K, C): HMAC-SHA1 licznika, dynamiczne obcięcie, `digits` cyfr. */
export function hotp(
  secret: Buffer,
  counter: number,
  digits = TOTP_DIGITS,
): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totpCode(secretBase32: string, step: number): string {
  return hotp(base32Decode(secretBase32), step);
}

/** `123 456` / `123-456` → `123456`; cokolwiek innego niż 6 cyfr → `null`. */
export function normalizeTotpCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const digits = input.replace(/[\s-]/g, '');
  return /^\d{6}$/.test(digits) ? digits : null;
}

/**
 * Krok, do którego pasuje kod (okno ±1), albo `null`.
 *
 * Kroki nie nowsze niż `lastUsedStep` są pomijane: kod raz przyjęty nie
 * działa drugi raz, także w swoim własnym oknie 90 sekund. To wołający
 * PRZEJMUJE zwrócony krok warunkowym zapisem (`lastUsedStep < krok`) — dopiero
 * wtedy dwa równoległe żądania z tym samym kodem nie przejdą oba.
 * Porównanie w stałym czasie.
 */
export function matchTotpStep(
  secretBase32: string,
  code: string,
  nowMs: number,
  lastUsedStep: number | null,
): number | null {
  const normalized = normalizeTotpCode(code);
  if (!normalized) return null;
  const secret = base32Decode(secretBase32);
  const current = totpStep(nowMs);
  const expected = Buffer.from(normalized);
  // Najpierw bieżący krok, potem sąsiednie — przy dwóch trafieniach (co przy
  // 10^6 kodów się nie zdarza) wygrywa bieżący.
  for (const offset of [0, -TOTP_WINDOW, TOTP_WINDOW]) {
    const step = current + offset;
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    const candidate = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(candidate, expected)) return step;
  }
  return null;
}

/** Adres `otpauth://` do kodu QR — to samo, co wpisuje się w aplikację ręcznie. */
export function otpauthUrl(input: {
  secret: string;
  issuer: string;
  account: string;
}): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
