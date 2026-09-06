import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

// AES-256-GCM dla sekretów, które musimy umieć odszyfrować (poświadczenia
// Cookidoo trzeba odtworzyć przy każdej wysyłce do mikroserwisu). To inna
// klasa niż refresh tokeny, gdzie wystarcza jednokierunkowy sha256+pepper.
// Format zapisu: "v1:<iv b64>:<tag b64>:<szyfrogram b64>" — wersjonowany
// prefiks pozwala kiedyś zrotować klucz bez zgadywania, czym co zaszyfrowano.

const VERSION = 'v1';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

export function parseEncryptionKey(base64Key: string | undefined): Buffer {
  const key = Buffer.from((base64Key ?? '').trim(), 'base64');
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      'COOKIDOO_ENCRYPTION_KEY musi być 32 bajtami w base64 (wygeneruj: openssl rand -base64 32).',
    );
  }
  return key;
}

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

export function decryptSecret(payload: string, key: Buffer): string {
  const [version, ivB64, tagB64, dataB64] = payload.split(':');
  if (version !== VERSION || !ivB64 || !tagB64 || !dataB64) {
    throw new Error(`Nieznany format zaszyfrowanego sekretu: ${version}`);
  }
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  // Node przyjmuje w GCM skrócone tagi (już od 4 bajtów) — a im krótszy tag,
  // tym łatwiej go zgadnąć. Nasz zapis ma zawsze pełne 16 bajtów, więc
  // wszystko inne to uszkodzony albo podrobiony wpis, nie „inna wersja".
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new Error('Uszkodzony zaszyfrowany sekret (długość IV lub tagu)');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv, {
    authTagLength: TAG_LENGTH,
  });
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
