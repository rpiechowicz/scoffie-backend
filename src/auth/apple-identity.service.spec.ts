import { UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type JWK,
  type KeyLike,
} from 'jose';
import { AppleIdentityService } from './apple-identity.service';

/**
 * Verifies the service end-to-end by:
 *  - Generating a throwaway RSA key pair in memory.
 *  - Signing a JWT with `iss=apple`, `aud=<bundle>`, `nonce=sha256(rawNonce)`.
 *  - Injecting a local JWKS resolver that returns our public key.
 */
describe('AppleIdentityService', () => {
  const AUDIENCE = 'rpiechowicz.weekly-meals';

  let privateKey: KeyLike;
  let publicJwk: JWK;
  let service: AppleIdentityService;

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    publicJwk = await exportJWK(pair.publicKey);
    publicJwk.kid = 'test-key-1';
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
  });

  beforeEach(() => {
    process.env.APPLE_AUDIENCE = AUDIENCE;
    service = new AppleIdentityService();
    // Inject a fake JWKS resolver that always returns our test public key.
    const localJwks = async () => {
      const { importJWK } = await import('jose');
      return importJWK(publicJwk, 'RS256');
    };
    service._overrideJwks(
      localJwks as unknown as ReturnType<
        typeof import('jose').createRemoteJWKSet
      >,
    );
  });

  async function signAppleLikeToken(
    overrides: Partial<{
      sub: string;
      email: string;
      emailVerified: boolean | string;
      aud: string;
      iss: string;
      nonce: string;
      expOffset: number;
    }> = {},
  ): Promise<string> {
    const payload: Record<string, unknown> = {
      sub: overrides.sub ?? '000111.abcdef.2222',
      aud: overrides.aud ?? AUDIENCE,
    };
    if (overrides.email !== undefined) payload.email = overrides.email;
    if (overrides.emailVerified !== undefined)
      payload.email_verified = overrides.emailVerified;
    if (overrides.nonce !== undefined) payload.nonce = overrides.nonce;

    return await new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer(overrides.iss ?? 'https://appleid.apple.com')
      .setIssuedAt()
      .setExpirationTime(`${overrides.expOffset ?? 600}s`)
      .sign(privateKey);
  }

  function hashNonce(raw: string) {
    return createHash('sha256').update(raw).digest('hex');
  }

  it('powinno zweryfikować poprawny token Apple', async () => {
    const rawNonce = 'abc-123-raw-nonce';
    const token = await signAppleLikeToken({
      nonce: hashNonce(rawNonce),
      email: 'rafal@example.com',
      emailVerified: 'true',
    });

    const result = await service.verify(token, rawNonce);
    expect(result.appleSub).toBe('000111.abcdef.2222');
    expect(result.email).toBe('rafal@example.com');
    expect(result.emailVerified).toBe(true);
    expect(result.audience).toBe(AUDIENCE);
  });

  it('powinno odrzucić token bez nonce', async () => {
    const rawNonce = 'some-nonce';
    const token = await signAppleLikeToken({ nonce: undefined });

    await expect(service.verify(token, rawNonce)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('powinno odrzucić token z niezgodnym nonce', async () => {
    const rawNonce = 'one-nonce';
    const token = await signAppleLikeToken({ nonce: hashNonce('other-nonce') });

    await expect(service.verify(token, rawNonce)).rejects.toThrow(/nonce/i);
  });

  it('powinno odrzucić token z niepoprawnym issuer', async () => {
    const rawNonce = 'n';
    const token = await signAppleLikeToken({
      nonce: hashNonce(rawNonce),
      iss: 'https://example.com',
    });

    await expect(service.verify(token, rawNonce)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('powinno odrzucić token z niepoprawnym audience', async () => {
    const rawNonce = 'n';
    const token = await signAppleLikeToken({
      nonce: hashNonce(rawNonce),
      aud: 'someone.elses.bundle',
    });

    await expect(service.verify(token, rawNonce)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('powinno odrzucić pusty identityToken lub rawNonce', async () => {
    await expect(service.verify('', 'nonce')).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(service.verify('token', '')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('powinno obsłużyć email_verified jako boolean', async () => {
    const rawNonce = 'rn';
    const token = await signAppleLikeToken({
      nonce: hashNonce(rawNonce),
      email: 'x@y.com',
      emailVerified: true,
    });

    const result = await service.verify(token, rawNonce);
    expect(result.emailVerified).toBe(true);
  });

  it('hashNonce powinno zwracać sha256(raw) w postaci hex', () => {
    const raw = 'abc';
    expect(service.hashNonce(raw)).toBe(hashNonce(raw));
  });
});
