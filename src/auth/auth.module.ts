import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AppleIdentityService } from './apple-identity.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { resolveJwtExpiresIn } from './jwt-expiration.util';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RollingTokenInterceptor } from './rolling-token.interceptor';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
      signOptions: {
        expiresIn: resolveJwtExpiresIn(process.env.JWT_EXPIRES_IN),
      },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AppleIdentityService,
    JwtAuthGuard,
    RollingTokenInterceptor,
  ],
  exports: [JwtModule, JwtAuthGuard, RollingTokenInterceptor],
})
export class AuthModule {}
