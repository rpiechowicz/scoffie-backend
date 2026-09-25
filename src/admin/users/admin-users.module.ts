import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { DataExportModule } from '../../data-export/data-export.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { UsersModule } from '../../users/users.module';
import { AdminCoreModule } from '../admin-core.module';
import {
  AdminDashboardController,
  AdminSearchController,
} from './admin-dashboard.controller';
import { AdminDashboardService } from './admin-dashboard.service';
import { AdminMailsService } from './admin-mails.service';
import { AdminSearchService } from './admin-search.service';
import {
  AdminMailsController,
  AdminUsersController,
} from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';

/**
 * Panel: pulpit, wyszukiwarka, użytkownicy i akcje na koncie osoby.
 *
 * Moduły domeny są tu po to, żeby akcje szły ICH drogą: `AuthModule`
 * (wylogowanie zewsząd pod zamkiem sesji), `UsersModule` (usunięcie konta
 * z rozliczeniem domu i pożegnaniem), `DataExportModule` (paczka RODO),
 * `NotificationsModule` (środowisko APNs urządzeń, które go nie podały).
 */
@Module({
  imports: [
    AdminCoreModule,
    AuthModule,
    DataExportModule,
    UsersModule,
    NotificationsModule,
  ],
  controllers: [
    AdminDashboardController,
    AdminSearchController,
    AdminUsersController,
    AdminMailsController,
  ],
  providers: [
    AdminDashboardService,
    AdminSearchService,
    AdminUsersService,
    AdminMailsService,
  ],
})
export class AdminUsersModule {}
