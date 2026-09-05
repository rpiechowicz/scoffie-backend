import { randomBytes } from 'crypto';
import {
  decryptSecret,
  encryptSecret,
  parseEncryptionKey,
} from './crypto.util';

describe('crypto.util', () => {
  const key = randomBytes(32);

  it('szyfruje i odszyfrowuje round-trip, z polskimi znakami', () => {
    const plain = 'zażółć-gęślą-jaźń@cookidoo.pl';
    const encrypted = encryptSecret(plain, key);
    expect(encrypted.startsWith('v1:')).toBe(true);
    expect(encrypted).not.toContain(plain);
    expect(decryptSecret(encrypted, key)).toBe(plain);
  });

  it('ten sam tekst daje różne szyfrogramy (losowy IV)', () => {
    expect(encryptSecret('haslo', key)).not.toBe(encryptSecret('haslo', key));
  });

  it('wykrywa manipulację szyfrogramem (tag GCM)', () => {
    const encrypted = encryptSecret('haslo', key);
    const parts = encrypted.split(':');
    const data = Buffer.from(parts[3], 'base64');
    data[0] ^= 0xff;
    parts[3] = data.toString('base64');
    expect(() => decryptSecret(parts.join(':'), key)).toThrow();
  });

  it('odrzuca skrócony tag GCM zamiast go zaakceptować', () => {
    // Node domyślnie przyjmuje tagi od 4 bajtów; 4-bajtowy tag zgaduje się
    // w 2^32 próbach, więc taki wpis ma być odrzucony jako uszkodzony.
    const encrypted = encryptSecret('haslo', key);
    const parts = encrypted.split(':');
    parts[2] = Buffer.from(parts[2], 'base64')
      .subarray(0, 4)
      .toString('base64');
    expect(() => decryptSecret(parts.join(':'), key)).toThrow(/tagu/);
  });

  it('odrzuca zły klucz', () => {
    const encrypted = encryptSecret('haslo', key);
    expect(() => decryptSecret(encrypted, randomBytes(32))).toThrow();
  });

  it('odrzuca nieznany format', () => {
    expect(() => decryptSecret('v9:a:b:c', key)).toThrow('Nieznany format');
  });

  it('parseEncryptionKey wymaga 32 bajtów base64', () => {
    expect(() => parseEncryptionKey(undefined)).toThrow(
      'COOKIDOO_ENCRYPTION_KEY',
    );
    expect(() => parseEncryptionKey('za-krotki')).toThrow();
    expect(parseEncryptionKey(randomBytes(32).toString('base64')).length).toBe(
      32,
    );
  });
});
