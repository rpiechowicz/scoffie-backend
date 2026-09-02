import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConsentsController } from './consents.controller';
import { ConsentsService } from './consents.service';

/** `PrismaModule` jest globalny; `AuthModule` daje `JwtAuthGuard`. */
@Module({
  imports: [AuthModule],
  controllers: [ConsentsController],
  providers: [ConsentsService],
  exports: [ConsentsService],
})
export class ConsentsModule {}
