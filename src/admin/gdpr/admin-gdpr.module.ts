import { Module } from '@nestjs/common';
import { AdminCoreModule } from '../admin-core.module';
import { AdminGdprController } from './admin-gdpr.controller';
import { AdminGdprService } from './admin-gdpr.service';

/**
 * Rejestr wniosków RODO (ekran „RODO”). Terminy pilnuje centrum alertów
 * (`gdprAlerts` w `alerts/alert-rules.ts`) — ten moduł tylko ewidencjonuje.
 */
@Module({
  imports: [AdminCoreModule],
  controllers: [AdminGdprController],
  providers: [AdminGdprService],
})
export class AdminGdprModule {}
