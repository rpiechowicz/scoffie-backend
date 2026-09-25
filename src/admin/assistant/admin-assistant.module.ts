import { Module } from '@nestjs/common';
import { AdminCoreModule } from '../admin-core.module';
import { AdminFxModule } from '../revenue/admin-fx.module';
import { AdminAssistantController } from './admin-assistant.controller';
import { AdminProfitService } from './admin-profit.service';
import { AdminReportsService } from './admin-reports.service';

/**
 * Ekran „Asystent” panelu: rentowność per zakres puli i kolejka zgłoszeń.
 * Tylko Prisma (moduł globalny) i wspólne klocki panelu — domena asystenta
 * nie ma serwisu dla kolumn decyzji o zgłoszeniu, a odczyty są agregatami.
 */
@Module({
  imports: [AdminCoreModule, AdminFxModule],
  controllers: [AdminAssistantController],
  providers: [AdminProfitService, AdminReportsService],
})
export class AdminAssistantModule {}
