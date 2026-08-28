import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { createHash } from 'crypto';
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyResult,
} from 'jose';

/**
 * Result of verifying an Apple identity token.
 * Derived directly from the JWT claims after signature + issuer + audience + nonce validation.
 */
export interface VerifiedAppleIdentity {
  /** Stable Apple user ID (JWT `sub`). */
  appleSub: string;
  /** User email from the JWT (may be a private relay @privaterelay.appleid.com address). */
  email: string | null;
  /** Whether Apple has verified the email on their end (`email_verified` claim). */
  emailVerified: boolean;
  /** Apple issued-at timestamp (seconds since epoch). */
  issuedAt: number;
  /** Apple expiration timestamp (seconds since epoch). */
  expiresAt: number;
  /** `aud` from the JWT — usually the iOS bundle ID. */
  audience: string;
}

/**
 * Service that verifies Apple ID identity tokens against Apple's JWKS.
 *
 * Security checks performed:
 *  - Signature: JWT is signed by one of Apple's published JWKs (RS256).
 *  - Issuer: must be `https://appleid.apple.com`.
 *  - Audience: must match the configured iOS bundle identifier (APPLE_AUDIENCE).
 *  - Expiration: `exp` must be in the future.
 *  - Nonce: SHA256(rawNonce) must match the JWT `nonce` claim (replay protection).
 *
 * See: https://developer.apple.com/documentation/sign_in_with_apple/sign_in_with_apple_rest_api/authenticating_users_with_sign_in_with_apple
 */
@Injectable()
export class AppleIdentityService {
  private readonly logger = new Logger(AppleIdentityService.name);

  private static readonly APPLE_ISSUER = 'https://appleid.apple.com';
  private static readonly APPLE_JWKS_URL =
    'https://appleid.apple.com/auth/keys';

  /**
   * Comma-separated list of allowed audiences (bundle IDs / services).
   * Defaults to the project bundle ID.
   */
  private readonly allowedAudiences: string[];

  /**
   * Lazily initialized JWKS fetcher. jose caches keys automatically and
   * refreshes on rotation. Safe to reuse across requests.
   */
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor() {
    const raw =
      process.env.APPLE_AUDIENCE ??
      process.env.APPLE_CLIENT_ID ??
      'rpiechowicz.weekly-meals';
    this.allowedAudiences = raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }

  private getJwks() {
    if (!this.jwks) {
      this.jwks = createRemoteJWKSet(
        new URL(AppleIdentityService.APPLE_JWKS_URL),
      );
    }
    return this.jwks;
  }

  /**
   * Test-only hook for injecting a JWKS resolver (used by unit tests).
   */
  _overrideJwks(jwks: ReturnType<typeof createRemoteJWKSet>) {
    this.jwks = jwks;
  }

  /**
   * Verifies an Apple identity token.
   *
   * @param identityToken JWT returned by Sign in with Apple as `identityToken`.
   * @param rawNonce The raw (pre-hash) nonce the client generated and passed to
   *                 ASAuthorizationAppleIDRequest.nonce. Required — Apple stores
   *                 `sha256(rawNonce)` in the JWT's `nonce` claim.
   */
  async verify(
    identityToken: string,
    rawNonce: string,
  ): Promise<VerifiedAppleIdentity> {
    if (!identityToken || typeof identityToken !== 'string') {
      throw new AppException(
        'APPLE_IDENTITY_INVALID',
        'Missing Apple identity token.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (!rawNonce || typeof rawNonce !== 'string') {
      throw new AppException(
        'APPLE_IDENTITY_INVALID',
        'Missing Apple nonce.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    let result: JWTVerifyResult<JWTPayload>;
    try {
      result = await jwtVerify(identityToken, this.getJwks(), {
        issuer: AppleIdentityService.APPLE_ISSUER,
        audience: this.allowedAudiences,
        // jose enforces `exp` automatically.
      });
    } catch (error) {
      this.logger.warn(
        `Apple identity token signature/claims rejected: ${(error as Error).message}`,
      );
      throw new AppException(
        'APPLE_IDENTITY_INVALID',
        'Invalid Apple identity token.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const payload = result.payload;

    // --- nonce check (replay protection) ---
    const expectedNonce = this.hashNonce(rawNonce);
    const jwtNonce = typeof payload.nonce === 'string' ? payload.nonce : '';
    if (!jwtNonce || jwtNonce !== expectedNonce) {
      this.logger.warn('Apple identity token nonce mismatch.');
      throw new AppException(
        'APPLE_IDENTITY_INVALID',
        'Apple nonce does not match.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    // --- mandatory claims ---
    const sub = typeof payload.sub === 'string' ? payload.sub : '';
    if (!sub) {
      throw new AppException(
        'APPLE_IDENTITY_INVALID',
        'Apple identity token missing sub claim.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const email =
      typeof payload.email === 'string' && payload.email.length > 0
        ? payload.email.toLowerCase()
        : null;

    // Apple returns `email_verified` as either boolean or the string "true"/"false".
    const rawVerified = payload.email_verified;
    const emailVerified =
      rawVerified === true ||
      rawVerified === 'true' ||
      rawVerified === 1 ||
      rawVerified === '1';

    const audience = Array.isArray(payload.aud)
      ? (payload.aud[0] ?? '')
      : typeof payload.aud === 'string'
        ? payload.aud
        : '';

    return {
      appleSub: sub,
      email,
      emailVerified,
      issuedAt: typeof payload.iat === 'number' ? payload.iat : 0,
      expiresAt: typeof payload.exp === 'number' ? payload.exp : 0,
      audience,
    };
  }

  /**
   * Computes `base64url(sha256(rawNonce))` — the form Apple stores in the JWT nonce claim.
   * Apple's SiwA server normalizes to base64url without padding.
   */
  hashNonce(rawNonce: string): string {
    // Apple actually stores sha256 as a lowercase hex string, NOT base64.
    // See https://developer.apple.com/forums/thread/685773 and the canonical
    // Ruby reference implementation. The hex form is what survives round-trips.
    return createHash('sha256').update(rawNonce).digest('hex');
  }
}
