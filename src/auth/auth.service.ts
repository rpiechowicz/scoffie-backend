import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleOauthDto } from './dto/google-oauth.dto';

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
