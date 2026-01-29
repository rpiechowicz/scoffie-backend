import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Issuer, Client } from 'openid-client';
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

    const accessToken = await this.jwtService.signAsync({
      sub: user.id,
    });

    return { accessToken, user };
  }
}
