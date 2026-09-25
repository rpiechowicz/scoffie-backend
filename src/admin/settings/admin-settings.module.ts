import { Module } from '@nestjs/common';
import { AdminCoreModule } from '../admin-core.module';
import { AdminSettingsController } from './admin-settings.controller';
import { AdminSettingsService } from './admin-settings.service';

/**
 * Ekran „Sterowanie” panelu (ROADMAPA §5.12): wyłącznik i limity asystenta
 * bez restartu. Zapis przez `RuntimeSettingsService` (moduł globalny).
 */
@Module({
  imports: [AdminCoreModule],
  controllers: [AdminSettingsController],
  providers: [AdminSettingsService],
})
export class AdminSettingsModule {}
