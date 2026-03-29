import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { DevLoginDto } from './dto/dev-login.dto';
import { GoogleOauthDto } from './dto/google-oauth.dto';
import { resolveJwtExpiresIn } from './jwt-expiration.util';

@Injectable()
export class AuthService {
  private readonly refreshTokenDays =
    Number(process.env.REFRESH_TOKEN_DAYS ?? '30') || 30;
  private readonly refreshTokenPepper =
    process.env.REFRESH_TOKEN_PEPPER ?? process.env.JWT_SECRET ?? 'dev-pepper';

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async loginWithGoogle(dto: GoogleOauthDto) {
    if (!dto.googleId || !dto.displayName) {
      throw new BadRequestException('Missing googleId or displayName');
    }

    const user = await this.prisma.user.upsert({
      where: { googleId: dto.googleId },
      update: {
        email: dto.email ?? null,
        displayName: dto.displayName,
        avatarUrl: dto.avatarUrl ?? null,
      },
      create: {
        googleId: dto.googleId,
        email: dto.email ?? null,
        displayName: dto.displayName,
        avatarUrl: dto.avatarUrl ?? null,
      },
    });

    const accessToken = await this.issueAccessToken(user.id);
    const refreshToken = await this.issueRefreshToken(user.id);

    return { accessToken, refreshToken };
  }

  async loginDev(dto: DevLoginDto) {
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
      },
      create: {
        googleId,
        displayName,
        email: normalizedEmail,
      },
    });

    const existingMembership = await this.prisma.membership.findFirst({
      where: { userId: user.id },
      include: { household: true },
      orderBy: { createdAt: 'asc' },
    });

    const household = existingMembership?.household ?? null;

    const accessToken = await this.issueAccessToken(user.id);
    const refreshToken = await this.issueRefreshToken(user.id);

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        displayName: user.displayName,
        email: user.email,
      },
      household:
        household === null
          ? null
          : {
              id: household.id,
              name: household.name,
            },
    };
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
