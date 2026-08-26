import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthProvider, Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AppleIdentityService } from './apple-identity.service';
import { AppleSignInDto } from './dto/apple-sign-in.dto';
import { DevLoginDto } from './dto/dev-login.dto';
import { GoogleOauthDto } from './dto/google-oauth.dto';
import { resolveJwtExpiresIn } from './jwt-expiration.util';

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    displayName: string;
    email: string | null;
    avatarUrl: string | null;
    /**
     * Indeks gradientu awatara przydzielony przy kończeniu onboardingu.
     * Jedzie już w odpowiedzi logowania, bo bez niego klient do czasu
     * pierwszego `users:me` kolorował własny awatar fallbackiem z hasza —
     * innym odcieniem niż ten, którym ta sama osoba świeci na listach
     * domowników.
     */
    avatarColor: number | null;
    provider: AuthProvider;
    onboardingCompletedAt: string | null;
  };
  household: { id: string; name: string } | null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  private readonly refreshTokenDays =
    Number(process.env.REFRESH_TOKEN_DAYS ?? '30') || 30;
  private readonly refreshTokenPepper =
    process.env.REFRESH_TOKEN_PEPPER ?? process.env.JWT_SECRET ?? 'dev-pepper';

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly appleIdentity: AppleIdentityService,
  ) {}

  async loginWithGoogle(dto: GoogleOauthDto): Promise<AuthResult> {
    if (!dto.googleId || !dto.displayName) {
      throw new BadRequestException('Missing googleId or displayName');
    }

    const user = await this.prisma.user.upsert({
      where: { googleId: dto.googleId },
      update: {
        email: dto.email ?? null,
        displayName: dto.displayName,
        avatarUrl: dto.avatarUrl ?? null,
        authProvider: AuthProvider.GOOGLE,
        lastLoginAt: new Date(),
      },
      create: {
        googleId: dto.googleId,
        email: dto.email ?? null,
        displayName: dto.displayName,
        avatarUrl: dto.avatarUrl ?? null,
        authProvider: AuthProvider.GOOGLE,
        lastLoginAt: new Date(),
      },
    });

    return this.buildAuthResult(user);
  }

  /**
   * Sign in with Apple.
   *
   * Steps:
   *  1. Verify the identity token against Apple's JWKS (signature, iss, aud, exp, nonce).
   *  2. Upsert a User keyed by the Apple `sub` claim.
   *  3. On first sign-in, Apple returns an email + optional fullName. Persist them once;
   *     subsequent sign-ins will NOT contain the name, so we never overwrite a good
   *     displayName with the fallback.
   *  4. Issue our own JWT + refresh token.
   */
  async loginWithApple(dto: AppleSignInDto): Promise<AuthResult> {
    if (!dto.identityToken?.trim()) {
      throw new BadRequestException('Missing identityToken.');
    }
    if (!dto.rawNonce?.trim()) {
      throw new BadRequestException('Missing rawNonce.');
    }

    const verified = await this.appleIdentity.verify(
      dto.identityToken.trim(),
      dto.rawNonce.trim(),
    );

    const displayNameFromApple = this.composeAppleDisplayName(
      dto.givenName,
      dto.familyName,
    );

    // Email: prefer the one from the verified JWT (signed by Apple);
    // fall back to DTO only if JWT didn't carry it for some reason.
    const email =
      verified.email ?? (dto.email?.trim().toLowerCase() || null) ?? null;

    // Look up existing user first so we can decide what to update.
    const existing = await this.prisma.user.findUnique({
      where: { appleSub: verified.appleSub },
    });

    let user;
    if (existing) {
      const updateData: Prisma.UserUpdateInput = {
        authProvider: AuthProvider.APPLE,
        lastLoginAt: new Date(),
      };

      // Only overwrite displayName if we got a real one from Apple AND
      // the user currently has the Apple-sub placeholder we assigned on first login.
      if (
        displayNameFromApple &&
        this.isPlaceholderDisplayName(existing.displayName)
      ) {
        updateData.displayName = displayNameFromApple;
      }

      // Only update email if we learn a new one; do not clear it.
      if (email && existing.email !== email) {
        updateData.email = email;
        updateData.emailVerified = verified.emailVerified;
      } else if (existing.email === email) {
        updateData.emailVerified = verified.emailVerified;
      }

      user = await this.prisma.user.update({
        where: { appleSub: verified.appleSub },
        data: updateData,
      });
    } else {
      const fallbackName =
        displayNameFromApple ||
        (email ? email.split('@')[0] : null) ||
        `Apple-${verified.appleSub.slice(0, 8)}`;

      user = await this.prisma.user.create({
        data: {
          appleSub: verified.appleSub,
          authProvider: AuthProvider.APPLE,
          email,
          emailVerified: email ? verified.emailVerified : false,
          displayName: fallbackName,
          lastLoginAt: new Date(),
        },
      });
      this.logger.log(
        `New Apple user created: ${user.id} (appleSub=${verified.appleSub.slice(0, 12)}…)`,
      );
    }

    return this.buildAuthResult(user);
  }

  async loginDev(dto: DevLoginDto): Promise<AuthResult> {
    if (process.env.AUTH_DEV_LOGIN_ENABLED === 'false') {
      throw new ForbiddenException('Dev login is disabled');
    }

    if (!dto.displayName?.trim()) {
      throw new BadRequestException('Missing displayName');
    }

    const displayName = dto.displayName.trim();
    const normalizedEmail = dto.email?.trim().toLowerCase() || null;
    const googleIdSeed = normalizedEmail || displayName.toLowerCase();
    const googleId = `dev:${googleIdSeed.replace(/\s+/g, '-')}`;

    const user = await this.prisma.user.upsert({
      where: { googleId },
      update: {
        displayName,
        email: normalizedEmail,
        authProvider: AuthProvider.DEV,
        lastLoginAt: new Date(),
      },
      create: {
        googleId,
        displayName,
        email: normalizedEmail,
        authProvider: AuthProvider.DEV,
        lastLoginAt: new Date(),
      },
    });

    return this.buildAuthResult(user);
  }

  async refreshAccessToken(refreshToken: string) {
    const tokenHash = this.hashRefreshToken(refreshToken);
    const storedToken = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });

    if (
      !storedToken ||
      storedToken.revokedAt ||
      storedToken.expiresAt <= new Date()
    ) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    await this.prisma.refreshToken.update({
      where: { tokenHash },
      data: { revokedAt: new Date() },
    });

    const accessToken = await this.issueAccessToken(storedToken.userId);
    const newRefreshToken = await this.issueRefreshToken(storedToken.userId);

    return { accessToken, refreshToken: newRefreshToken };
  }

  async issueAccessToken(userId: string) {
    const expiresIn = resolveJwtExpiresIn(process.env.JWT_EXPIRES_IN);
    return this.jwtService.signAsync({ sub: userId }, { expiresIn });
  }

  private async buildAuthResult(user: {
    id: string;
    displayName: string;
    email: string | null;
    avatarUrl: string | null;
    avatarColor: number | null;
    authProvider: AuthProvider;
    onboardingCompletedAt: Date | null;
  }): Promise<AuthResult> {
    const [accessToken, refreshToken, membership] = await Promise.all([
      this.issueAccessToken(user.id),
      this.issueRefreshToken(user.id),
      this.prisma.membership.findFirst({
        where: { userId: user.id },
        include: { household: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        displayName: user.displayName,
        email: user.email,
        avatarUrl: user.avatarUrl ?? null,
        avatarColor: user.avatarColor ?? null,
        provider: user.authProvider,
        onboardingCompletedAt:
          user.onboardingCompletedAt?.toISOString() ?? null,
      },
      household: membership?.household
        ? { id: membership.household.id, name: membership.household.name }
        : null,
    };
  }

  private async issueRefreshToken(userId: string) {
    const rawToken = randomBytes(64).toString('hex');
    const tokenHash = this.hashRefreshToken(rawToken);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + this.refreshTokenDays);

    await this.prisma.refreshToken.create({
      data: {
        tokenHash,
        userId,
        expiresAt,
      },
    });

    return rawToken;
  }

  private hashRefreshToken(token: string) {
    return createHash('sha256')
      .update(token)
      .update(this.refreshTokenPepper)
      .digest('hex');
  }

  private composeAppleDisplayName(
    givenName?: string,
    familyName?: string,
  ): string | null {
    const parts = [givenName, familyName]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value && value.length));
    return parts.length > 0 ? parts.join(' ') : null;
  }

  /**
   * `displayName` placeholders we auto-generated on first login
   * (e.g. "Apple-abcd1234" or email-local-part). If the user hasn't changed
   * them, overwrite them when Apple finally gives us a real name.
   */
  private isPlaceholderDisplayName(displayName: string): boolean {
    if (!displayName) return true;
    if (displayName.startsWith('Apple-')) return true;
    // Email-local-part heuristic — a single lowercase token without spaces.
    return /^[a-z0-9._-]+$/.test(displayName);
  }
}
