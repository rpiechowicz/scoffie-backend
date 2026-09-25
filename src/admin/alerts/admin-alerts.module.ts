import { Module } from '@nestjs/common';
import { MailModule } from '../../mail/mail.module';
import { AdminCoreModule } from '../admin-core.module';
import { AdminFxModule } from '../revenue/admin-fx.module';
import { AdminUsersModule } from '../users/admin-users.module';
import {
  AdminAlertsController,
  AdminDailyReportController,
} from './admin-alerts.controller';
import { AdminAlertsService } from './admin-alerts.service';
import { AdminDailyReportService } from './admin-daily-report.service';
import { AdminWatchService } from './admin-watch.service';

/**
 * Centrum alertów (`AdminWatchService`, co 10 min) i raport „Scoffie
 * wczoraj” o 7:00 (`AdminDailyReportService`). Maile do operatora idą tą
 * samą skrzynką nadawczą co maile do osób (`MailModule`), a liczby raportu
 * tą samą arytmetyką co pulpit (`AdminUsersModule` → `AdminDashboardService`).
 */
@Module({
  imports: [AdminCoreModule, MailModule, AdminUsersModule, AdminFxModule],
  controllers: [AdminAlertsController, AdminDailyReportController],
  providers: [AdminWatchService, AdminDailyReportService, AdminAlertsService],
})
export class AdminAlertsModule {}
