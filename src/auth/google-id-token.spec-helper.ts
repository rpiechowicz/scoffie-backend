import { createSign, generateKeyPairSync } from 'crypto';

/**
 * Podrobiony „Google” do testów: własna para kluczy RSA, a tokeny podpisane
 * nią przechodzą PRAWDZIWĄ weryfikację `google-auth-library` po podstawieniu
 * certyfikatów (`GoogleIdentityService._overrideCerts`). Bez sieci.
 */
export const TEST_GOOGLE_CLIENT_ID =
  'test-web-client.apps.googleusercontent.com';

export function makeFakeGoogle() {
  const kid = 'test-kid-1';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const certs = {
    [kid]: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };

  const b64url = (value: string | Buffer) =>
    Buffer.from(value).toString('base64url');

  const sign = (claims: Record<string, unknown>, keyId = kid): string => {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: 'https://accounts.google.com',
      aud: TEST_GOOGLE_CLIENT_ID,
      iat: now,
      exp: now + 3600,
      ...claims,
    };
    const signed = `${b64url(JSON.stringify({ alg: 'RS256', kid: keyId, typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}`;
    const signature = createSign('RSA-SHA256')
      .update(signed)
      .end()
      .sign(privateKey);
    return `${signed}.${b64url(signature)}`;
  };

  return { certs, sign };
}
