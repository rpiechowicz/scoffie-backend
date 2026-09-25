import { Module } from '@nestjs/common';
import { AdminCoreModule } from '../admin-core.module';
import {
  AdminAppStoreController,
  AdminMailController,
  AdminOpsController,
} from './admin-integrations.controller';
import { AdminIntegrationsService } from './admin-integrations.service';
import { AdminMailService } from './admin-mail.service';

/**
 * Ekrany „Poczta”, „System” i „App Store” panelu. Klucze zewnętrznych
 * serwisów: `integrations-env.ts`; lista zmiennych: `.env.example`.
 */
@Module({
  imports: [AdminCoreModule],
  controllers: [
    AdminMailController,
    AdminOpsController,
    AdminAppStoreController,
  ],
  providers: [AdminMailService, AdminIntegrationsService],
})
export class AdminIntegrationsModule {}
