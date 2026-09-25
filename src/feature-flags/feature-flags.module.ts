import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FeatureFlagsController } from './feature-flags.controller';
import { FeatureFlagsService } from './feature-flags.service';

/**
 * Flagi funkcji per dom. Globalny, bo `isEnabled` ma być dostępne w każdym
 * module funkcji bez dopisywania importów; `AuthModule` daje `JwtAuthGuard`.
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [FeatureFlagsController],
  providers: [FeatureFlagsService],
  exports: [FeatureFlagsService],
})
export class FeatureFlagsModule {}
