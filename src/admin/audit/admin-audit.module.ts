import { Module } from '@nestjs/common';
import { AdminCoreModule } from '../admin-core.module';
import { AdminAuditLogService } from './admin-audit-log.service';
import { AdminAuditController } from './admin-audit.controller';

/** Ekran „Dziennik” panelu. Zapis wpisów: `AdminAuditService` (rdzeń). */
@Module({
  imports: [AdminCoreModule],
  controllers: [AdminAuditController],
  providers: [AdminAuditLogService],
})
export class AdminAuditModule {}
