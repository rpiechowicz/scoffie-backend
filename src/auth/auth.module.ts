import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AccessTokenService } from './access-token.service';
import { AppleIdentityService } from './apple-identity.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { resolveJwtExpiresIn } from './jwt-expiration.util';
import { JwtAuthGuard } from './jwt-auth.guard';
import { UserActivityService } from './user-activity.service';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
      signOptions: {
        algorithm: 'HS256',
        expiresIn: resolveJwtExpiresIn(process.env.JWT_EXPIRES_IN),
      },
      // Jawna lista algorytmów przy weryfikacji: token z innym `alg` w
      // nagłówku ma być odrzucony od razu, a nie zależeć od domyślnych
      // ustawień biblioteki w kolejnej wersji.
      verifyOptions: { algorithms: ['HS256'] },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AppleIdentityService,
    AccessTokenService,
    JwtAuthGuard,
    UserActivityService,
  ],
  // `AccessTokenService` bierze też `app.get()` w `configureApp` — adapter
  // WebSocketu żyje poza DI. `RollingTokenInterceptor` odszedł: nigdy nie był
  // podpięty, a przy streamingu asystenta nagłówek z nowym tokenem nie ma
  // sensu — odświeżanie idzie przez `POST /auth/refresh`.
  // `AuthService` — panel administratora woła `logoutEverywhere` tą samą
  // drogą co `POST /auth/logout-everywhere` (zamek sesji, `tokenVersion`).
  // `UserActivityService` — zależność `JwtAuthGuard` (moduły, które go
  // używają, rozwiązują ją z tego eksportu) i adaptera WS (`configureApp`).
  exports: [
    JwtModule,
    JwtAuthGuard,
    AccessTokenService,
    AuthService,
    UserActivityService,
  ],
})
export class AuthModule {}
