import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { readThrottleLimit } from '../common/throttle/throttle-env';
import { refreshTokenTracker } from '../common/throttle/refresh-token-tracker';
import { AuthService } from './auth.service';
import { CurrentUserId } from './current-user-id.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AppleSignInDto } from './dto/apple-sign-in.dto';
import { DevLoginDto } from './dto/dev-login.dto';
import { GoogleSignInDto } from './dto/google-sign-in.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';

@ApiTags('auth')
// Logowanie limitujemy ostrzej niż resztę i po IP: żądanie jest z natury bez
// tokenu, więc tracker throttlera i tak nie ma tożsamości. To bariera na
// zgadywanie (`/auth/apple`, `/auth/google`), nie na pętlę w kliencie.
// `/auth/refresh` ma własne limity — per sesja i luźny bezpiecznik IP.
@Throttle({
  default: { limit: () => readThrottleLimit('THROTTLE_AUTH_LIMIT') },
})
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Sign in with Apple. iOS is expected to send:
   *  - `identityToken` — the JWT produced by ASAuthorizationAppleIDCredential.
   *  - `rawNonce` — the pre-hashed nonce that was SHA256'd into the request nonce.
   *  - `givenName` / `familyName` / `email` — ONLY on first sign-in per Apple ID.
   *
   * Returns the same envelope as the dev endpoint so the iOS app can reuse
   * existing session persistence logic.
   */
  @Post('apple')
  @ApiOkResponse({
    schema: {
      example: {
        accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        refreshToken: 'd3b07384d113edec49eaa6238ad5ff00...',
        user: {
          id: 'edbc139a-636b-4aaf-953f-9b4644eb8b55',
          displayName: 'Rafał Piechowicz',
          email: 'rafal@example.com',
          provider: 'APPLE',
        },
        household: {
          id: 'f6478b3a-5f76-47fd-94cd-e85c2564e366',
          name: 'Home',
        },
      },
    },
  })
  loginWithApple(@Body() dto: AppleSignInDto) {
    return this.authService.loginWithApple(dto);
  }

  /**
   * Logowanie przez Google (aplikacja Android). Ciało: `idToken` z Credential
   * Managera, opcjonalnie `nonce` (musi zgadzać się z claimem) i `platform`.
   *
   * Ta sama koperta co `/auth/apple`. Nieważny token = 401
   * `APPLE_IDENTITY_INVALID` (ten sam kod co zły token Apple); brak
   * `GOOGLE_OAUTH_CLIENT_IDS` = 503 `SERVICE_UNAVAILABLE`.
   */
  @Post('google')
  @ApiOkResponse({
    schema: {
      example: {
        accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        refreshToken: 'd3b07384d113edec49eaa6238ad5ff00...',
        user: {
          id: 'edbc139a-636b-4aaf-953f-9b4644eb8b55',
          displayName: 'Rafał Piechowicz',
          email: 'rafal@example.com',
          provider: 'GOOGLE',
        },
        household: {
          id: 'f6478b3a-5f76-47fd-94cd-e85c2564e366',
          name: 'Home',
        },
      },
    },
  })
  loginWithGoogle(@Body() dto: GoogleSignInDto) {
    return this.authService.loginWithGoogle(dto);
  }

  @Post('dev')
  @ApiOkResponse({
    schema: {
      example: {
        accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        refreshToken: 'd3b07384d113edec49eaa6238ad5ff00...',
        user: {
          id: 'edbc139a-636b-4aaf-953f-9b4644eb8b55',
          displayName: 'Rafał Piechowicz',
          email: 'rafal@example.com',
          provider: 'DEV',
        },
        household: {
          id: 'f6478b3a-5f76-47fd-94cd-e85c2564e366',
          name: 'Home',
        },
      },
    },
  })
  loginDev(@Body() dto: DevLoginDto) {
    return this.authService.loginDev(dto);
  }

  @Post('refresh')
  // Per SESJA (hasz refresh tokenu), nie per IP: za NAT-em setki telefonów
  // mają jeden adres, a nieudane odświeżenie wylogowuje. Siatkę `ip` dla tej
  // trasy luzujemy do własnego bezpiecznika — patrz `refreshTokenTracker`.
  @Throttle({
    default: {
      limit: () => readThrottleLimit('THROTTLE_AUTH_REFRESH_LIMIT'),
      getTracker: refreshTokenTracker,
    },
    ip: { limit: () => readThrottleLimit('THROTTLE_AUTH_REFRESH_IP_LIMIT') },
  })
  @ApiOkResponse({
    schema: {
      example: {
        accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        refreshToken: '8f14e45fceea167a5a36dedd4bea2543...',
      },
    },
  })
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refreshAccessToken(dto.refreshToken);
  }

  /**
   * Unieważnia refresh token przy wylogowaniu. Zawsze 200 — klient nie musi
   * wiedzieć, czy token był jeszcze ważny.
   */
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ schema: { example: { revoked: true } } })
  logout(@Body() dto: RefreshTokenDto) {
    return this.authService.logout(dto.refreshToken);
  }

  /**
   * Wylogowanie ze WSZYSTKICH urządzeń: każdy refresh token i każdy token
   * dostępu tej osoby przestaje działać, otwarte sockety się rozłączają.
   *
   * Poświadczeniem jest TOKEN DOSTĘPU (`Authorization: Bearer`), nie refresh
   * token w ciele: tożsamość idzie wyłącznie z sesji, a żądanie nie przyjmuje
   * żadnych identyfikatorów. Ten sam token dostępu nie zadziała drugi raz —
   * `tokenVersion` go unieważnia. Bez ciała, zawsze 200 z liczbą zgaszonych
   * refresh tokenów; klient i tak ma się po nim zalogować od nowa.
   */
  @Post('logout-everywhere')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ schema: { example: { revokedSessions: 3 } } })
  logoutEverywhere(@CurrentUserId() userId: string) {
    return this.authService.logoutEverywhere(userId);
  }
}
