import { Body, Controller, Post } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { GoogleOauthDto } from './dto/google-oauth.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('google')
  @ApiOkResponse({
    schema: {
      example: {
        accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        user: {
          id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
          googleId: '1234567890',
          displayName: 'Anna Nowak',
          avatarUrl: 'https://i.pravatar.cc/150?img=47',
          createdAt: '2026-01-29T17:00:00.000Z',
          updatedAt: '2026-01-29T17:00:00.000Z',
        },
      },
    },
  })
  loginWithGoogle(@Body() dto: GoogleOauthDto) {
    return this.authService.loginWithGoogle(dto);
  }
}
