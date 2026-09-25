import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type KeyLike,
} from 'jose';
import { readAdminEnv } from '../../config/admin-env';
import { AccessJwtVerifier } from './access-jwt.verifier';

/**
 * Bramka Cloudflare Access — każda odmowa ma skończyć się `null` (guard
 * zamienia to na 404 nie do odróżnienia od braku trasy). Klucze generowane
 * w pamięci; JWKS podstawiony lokalnie, jak w `apple-identity.service.spec.ts`.
 */
describe('AccessJwtVerifier', () => {
  const TEAM = 'scoffie.cloudflareaccess.com';
  const AUD = 'aud-tag-panelu';
  const env = readAdminEnv({
    ADMIN_ACCESS_TEAM_DOMAIN: `https://${TEAM}/`,
    ADMIN_ACCESS_AUD: AUD,
  } as NodeJS.ProcessEnv);

  let privateKey: KeyLike;
  let strangerKey: KeyLike;
  let publicJwk: JWK;
  let verifier: AccessJwtVerifier;

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    strangerKey = (await generateKeyPair('RS256')).privateKey;
    publicJwk = {
      ...(await exportJWK(pair.publicKey)),
      kid: 'k1',
      alg: 'RS256',
    };
  });

  beforeEach(() => {
    verifier = new AccessJwtVerifier();
    verifier._overrideJwks(createLocalJWKSet({ keys: [publicJwk] }));
  });

  type Claims = {
    iss?: string;
    aud?: string;
    email?: string | null;
    expSeconds?: number | null;
    key?: KeyLike;
  };

  async function token(claims: Claims = {}): Promise<string> {
    const payload: Record<string, unknown> = { type: 'app' };
    if (claims.email !== null)
      payload.email = claims.email ?? 'Rafal@Example.com';
    let jwt = new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(claims.iss ?? `https://${TEAM}`)
      .setAudience(claims.aud ?? AUD)
      .setSubject('access-sub-1')
      .setIssuedAt();
    if (claims.expSeconds !== null) {
      jwt = jwt.setExpirationTime(
        Math.floor(Date.now() / 1000) + (claims.expSeconds ?? 3600),
      );
    }
    return jwt.sign(claims.key ?? privateKey);
  }

  it('poprawny token daje adres małymi literami i sub', async () => {
    await expect(verifier.verify(await token(), env)).resolves.toEqual({
      email: 'rafal@example.com',
      subject: 'access-sub-1',
    });
  });

  it.each<[string, Claims]>([
    ['zły aud (inna aplikacja Access)', { aud: 'inna-aplikacja' }],
    ['zły iss (inny zespół)', { iss: 'https://obcy.cloudflareaccess.com' }],
    ['wygasły (godzinę temu)', { expSeconds: -3600 }],
    ['bez exp (jose przepuściłby go jako wieczny)', { expSeconds: null }],
    ['bez adresu e-mail (token usługi)', { email: null }],
    ['adres bez @', { email: 'nie-adres' }],
  ])('odmawia: %s', async (_label, claims) => {
    await expect(verifier.verify(await token(claims), env)).resolves.toBeNull();
  });

  it('odmawia tokenu podpisanego cudzym kluczem', async () => {
    await expect(
      verifier.verify(await token({ key: strangerKey }), env),
    ).resolves.toBeNull();
  });

  it('odmawia tokenu z alg HS256 (podmiana algorytmu)', async () => {
    const forged = await new SignJWT({ email: 'rafal@example.com' })
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setIssuer(`https://${TEAM}`)
      .setAudience(AUD)
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('x'.repeat(64)));
    await expect(verifier.verify(forged, env)).resolves.toBeNull();
  });

  it.each([
    ['pusty nagłówek', ''],
    ['śmieci zamiast JWT', 'to-nie-jest-jwt'],
  ])('odmawia: %s', async (_label, raw) => {
    await expect(verifier.verify(raw, env)).resolves.toBeNull();
  });

  it('bez konfiguracji bramki odmawia nawet poprawnego tokenu', async () => {
    const good = await token();
    await expect(
      verifier.verify(good, readAdminEnv({} as NodeJS.ProcessEnv)),
    ).resolves.toBeNull();
    await expect(
      verifier.verify(
        good,
        readAdminEnv({
          ADMIN_ACCESS_TEAM_DOMAIN: TEAM,
        } as NodeJS.ProcessEnv),
      ),
    ).resolves.toBeNull();
  });
});
