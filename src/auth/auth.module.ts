import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RollingTokenInterceptor } from './rolling-token.interceptor';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
      signOptions: { expiresIn: (process.env.JWT_EXPIRES_IN ?? '30d') as any },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, RollingTokenInterceptor],
  exports: [JwtModule, JwtAuthGuard, RollingTokenInterceptor],
})
export class AuthModule {}
