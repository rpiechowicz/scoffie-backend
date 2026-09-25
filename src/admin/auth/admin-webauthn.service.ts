import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { randomBytes } from 'crypto';
import { AppException } from '../../common/app-exception';
import { readAdminEnv } from '../../config/admin-env';
import { PrismaService } from '../../prisma/prisma.service';

export type ChallengePurpose = 'LOGIN' | 'REGISTER' | 'STEP_UP';

/** Ile żyje wyzwanie między `…/options` a weryfikacją. */
export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60_000;
const RP_NAME = 'Scoffie — panel';

/** Z czym wiążemy wyzwanie: adres z bramki i (poza logowaniem) sesja. */
export type ChallengeBinding = { email: string; sessionId: string | null };

export type VerifiedRegistration = {
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
  /** Uchwyt WebAuthn z opcji — przy bootstrapie to uchwyt nowego konta. */
  webauthnUserId: string;
  /** Konto, dla którego wydano opcje; `null` = bootstrap. */
  adminUserId: string | null;
};

type ChallengeRow = {
  id: string;
  purpose: string;
  email: string;
  adminUserId: string | null;
  sessionId: string | null;
  webauthnUserId: string | null;
  expiresAt: Date;
  usedAt: Date | null;
};

/** Znane kanały authenticatora — reszta z odpowiedzi przeglądarki odpada. */
const TRANSPORTS = new Set([
  'ble',
  'cable',
  'hybrid',
  'internal',
  'nfc',
  'smart-card',
  'usb',
]);
const asTransports = (values: string[]): string[] =>
  values.filter((value) => TRANSPORTS.has(value));

/**
 * Passkeye panelu przez `@simplewebauthn/server`.
 *
 * WYZWANIA W BAZIE, NIE W PAMIĘCI: między `…/options` a weryfikacją stoi
 * Face ID, a w tym czasie może przyjść deploy. Wyzwanie jest jednorazowe —
 * przejmuje je warunkowy `updateMany(usedAt: null)` wewnątrz weryfikatora
 * (`expectedChallenge` jako funkcja), więc ta sama odpowiedź WebAuthn nie
 * przejdzie dwa razy, nawet równolegle. Wyzwanie zna adres z bramki, a przy
 * rejestracji z sesją i przy step-upie — także sesję: odpowiedź wygenerowana
 * dla jednej sesji nie zaloguje innej.
 *
 * `userVerification: 'required'`: passkey ma być DWUSKŁADNIKOWY sam w sobie
 * (urządzenie + biometria/PIN) — bez tego wystarczyłoby dotknięcie klucza.
 */
@Injectable()
export class AdminWebAuthnService {
  private readonly logger = new Logger(AdminWebAuthnService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** RP z env albo 503 — bez nich przeglądarka i tak odrzuci każdą próbę. */
  private rp(): { rpID: string; origins: string[] } {
    const env = readAdminEnv();
    if (!env.webauthnRpId || env.webauthnOrigins.length === 0) {
      throw new AppException(
        'SERVICE_UNAVAILABLE',
        'Passkeye panelu nie są skonfigurowane (ADMIN_WEBAUTHN_RP_ID / ADMIN_WEBAUTHN_ORIGIN).',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return { rpID: env.webauthnRpId, origins: env.webauthnOrigins };
  }

  async registrationOptions(input: {
    email: string;
    admin: { id: string; webauthnUserId: string; displayName: string } | null;
    sessionId: string | null;
  }): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const { rpID } = this.rp();
    const webauthnUserId =
      input.admin?.webauthnUserId ?? randomBytes(32).toString('base64url');
    const existing = input.admin
      ? await this.prisma.adminCredential.findMany({
          where: { adminUserId: input.admin.id },
          select: { credentialId: true, transports: true },
        })
      : [];
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userName: input.email,
      userID: new Uint8Array(Buffer.from(webauthnUserId, 'base64url')),
      userDisplayName: input.admin?.displayName ?? input.email,
      attestationType: 'none',
      timeout: WEBAUTHN_CHALLENGE_TTL_MS,
      excludeCredentials: existing.map((credential) => ({
        id: credential.credentialId,
        transports: asTransports(credential.transports),
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
      },
    });
    await this.storeChallenge(options.challenge, 'REGISTER', {
      email: input.email,
      adminUserId: input.admin?.id ?? null,
      sessionId: input.sessionId,
      webauthnUserId,
    });
    return options;
  }

  /** `null` = odpowiedź nie przeszła (zły podpis, zużyte wyzwanie, …). Nie rzuca. */
  async verifyRegistration(
    response: RegistrationResponseJSON,
    binding: ChallengeBinding,
  ): Promise<VerifiedRegistration | null> {
    const { rpID, origins } = this.rp();
    let challenge: ChallengeRow | null = null;
    try {
      const result = await verifyRegistrationResponse({
        response,
        expectedChallenge: async (value) => {
          challenge = await this.consume(value, 'REGISTER', binding);
          return challenge !== null;
        },
        expectedOrigin: origins,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
      const used = challenge as ChallengeRow | null;
      if (!result.verified || !used?.webauthnUserId) return null;
      const info = result.registrationInfo;
      return {
        credentialId: info.credential.id,
        publicKey: info.credential.publicKey,
        counter: info.credential.counter,
        transports: asTransports(info.credential.transports ?? []),
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
        webauthnUserId: used.webauthnUserId,
        adminUserId: used.adminUserId,
      };
    } catch (error) {
      this.logger.debug(
        `rejestracja passkeya odrzucona: ${error instanceof Error ? error.message : 'błąd'}`,
      );
      return null;
    }
  }

  async authenticationOptions(input: {
    email: string;
    adminUserId: string | null;
    sessionId: string | null;
    purpose: 'LOGIN' | 'STEP_UP';
  }): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const { rpID } = this.rp();
    const credentials = input.adminUserId
      ? await this.prisma.adminCredential.findMany({
          where: { adminUserId: input.adminUserId },
          select: { credentialId: true, transports: true },
        })
      : [];
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: credentials.map((credential) => ({
        id: credential.credentialId,
        transports: asTransports(credential.transports),
      })),
      userVerification: 'required',
      timeout: WEBAUTHN_CHALLENGE_TTL_MS,
    });
    await this.storeChallenge(options.challenge, input.purpose, {
      email: input.email,
      adminUserId: input.adminUserId,
      sessionId: input.sessionId,
      webauthnUserId: null,
    });
    return options;
  }

  /**
   * Weryfikacja podpisu passkeyem NALEŻĄCYM do tego admina. Zwraca id wiersza
   * klucza albo `null`. Licznik podpisów pilnuje biblioteka (spadek = błąd).
   */
  async verifyAuthentication(
    response: AuthenticationResponseJSON,
    input: ChallengeBinding & {
      adminUserId: string;
      purpose: 'LOGIN' | 'STEP_UP';
    },
  ): Promise<{ credentialRowId: string } | null> {
    const { rpID, origins } = this.rp();
    const credentialId =
      response && typeof response.id === 'string' ? response.id : '';
    if (!credentialId || credentialId.length > 1024) return null;
    const credential = await this.prisma.adminCredential.findUnique({
      where: { credentialId },
    });
    if (!credential || credential.adminUserId !== input.adminUserId) {
      return null;
    }
    try {
      const result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: async (value) =>
          (await this.consume(value, input.purpose, input)) !== null,
        expectedOrigin: origins,
        expectedRPID: rpID,
        credential: {
          id: credential.credentialId,
          publicKey: new Uint8Array(credential.publicKey),
          counter: credential.counter,
          transports: asTransports(credential.transports),
        },
        requireUserVerification: true,
      });
      if (!result.verified) return null;
      await this.prisma.adminCredential.update({
        where: { id: credential.id },
        data: {
          counter: result.authenticationInfo.newCounter,
          backedUp: result.authenticationInfo.credentialBackedUp,
          lastUsedAt: new Date(),
        },
      });
      return { credentialRowId: credential.id };
    } catch (error) {
      this.logger.debug(
        `logowanie passkeyem odrzucone: ${error instanceof Error ? error.message : 'błąd'}`,
      );
      return null;
    }
  }

  private async storeChallenge(
    challenge: string,
    purpose: ChallengePurpose,
    data: {
      email: string;
      adminUserId: string | null;
      sessionId: string | null;
      webauthnUserId: string | null;
    },
  ): Promise<void> {
    await this.prisma.adminWebAuthnChallenge.create({
      data: {
        challenge,
        purpose,
        ...data,
        expiresAt: new Date(Date.now() + WEBAUTHN_CHALLENGE_TTL_MS),
      },
    });
  }

  /**
   * Przejęcie wyzwania: musi istnieć, pasować celem, adresem i sesją, żyć
   * i nie być zużyte. Zużycie to warunkowy zapis — wygrywa dokładnie jedno
   * żądanie.
   */
  private async consume(
    challenge: string,
    purpose: ChallengePurpose,
    binding: ChallengeBinding,
    now: Date = new Date(),
  ): Promise<ChallengeRow | null> {
    const row = await this.prisma.adminWebAuthnChallenge.findUnique({
      where: { challenge },
    });
    if (
      !row ||
      row.purpose !== purpose ||
      row.email !== binding.email ||
      row.sessionId !== binding.sessionId ||
      row.usedAt ||
      row.expiresAt.getTime() <= now.getTime()
    ) {
      return null;
    }
    const { count } = await this.prisma.adminWebAuthnChallenge.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: now },
    });
    return count === 1 ? row : null;
  }
}
