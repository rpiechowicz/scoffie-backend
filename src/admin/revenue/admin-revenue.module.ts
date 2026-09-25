import { Module } from '@nestjs/common';
import { AdminCoreModule } from '../admin-core.module';
import { AdminFxModule } from './admin-fx.module';
import { AdminRevenueController } from './admin-revenue.controller';
import { AdminRevenueService } from './admin-revenue.service';
import { AppleReportsSyncService } from './apple-reports-sync.service';

/**
 * Przychód z Apple: synchronizacja raportów App Store Connect do bazy
 * (`AppleReportsSyncService`) i ekran „Wypłaty z Apple” (`/admin/revenue`).
 */
@Module({
  imports: [AdminCoreModule, AdminFxModule],
  controllers: [AdminRevenueController],
  providers: [AdminRevenueService, AppleReportsSyncService],
})
export class AdminRevenueModule {}
