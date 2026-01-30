import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Issuer, Client } from 'openid-client';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleOauthDto } from './dto/google-oauth.dto';

type GoogleProfile = {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
};

@Injectable()
export class AuthService {
  private googleClientPromise: Promise<Client> | null = null;
  private readonly refreshTokenDays =
    Number(process.env.REFRESH_TOKEN_DAYS ?? '30') || 30;
  private readonly refreshTokenPepper =
    process.env.REFRESH_TOKEN_PEPPER ?? process.env.JWT_SECRET ?? 'dev-pepper';

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  private async getGoogleClient(): Promise<Client> {
    if (!this.googleClientPromise) {
      const issuer = await Issuer.discover('https://accounts.google.com');
      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        throw new Error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET');
      }
      this.googleClientPromise = Promise.resolve(
        new issuer.Client({
          client_id: clientId,
          client_secret: clientSecret,
        }),
      );
    }
    return this.googleClientPromise;
  }

  async loginWithGoogle(dto: GoogleOauthDto) {
    const client = await this.getGoogleClient();
    const tokenSet = await client.callback(
      dto.redirectUri,
      { code: dto.code },
      { code_verifier: dto.codeVerifier },
    );

    const claims = tokenSet.claims() as GoogleProfile;
    if (!claims?.sub) {
      throw new UnauthorizedException('Invalid Google token');
    }

    const user = await this.prisma.user.upsert({
      where: { googleId: claims.sub },
      update: {
        email: claims.email ?? null,
        displayName: claims.name ?? 'Google User',
        avatarUrl: claims.picture ?? null,
      },
      create: {
        googleId: claims.sub,
        email: claims.email ?? null,
        displayName: claims.name ?? 'Google User',
        avatarUrl: claims.picture ?? null,
      },
    });

    const accessToken = await this.issueAccessToken(user.id);
    const refreshToken = await this.issueRefreshToken(user.id);

    return { accessToken, refreshToken };
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
    const expiresIn = process.env.JWT_EXPIRES_IN ?? '30d';
    return this.jwtService.signAsync({ sub: userId }, { expiresIn: expiresIn as any });
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
}
