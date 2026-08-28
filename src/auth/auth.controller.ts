import { Body, Controller, Post } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { AppleSignInDto } from './dto/apple-sign-in.dto';
import { DevLoginDto } from './dto/dev-login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';

@ApiTags('auth')
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
}
