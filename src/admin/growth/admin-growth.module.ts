import { Module } from '@nestjs/common';
import { AdminCoreModule } from '../admin-core.module';
import { AdminGrowthController } from './admin-growth.controller';
import { AdminGrowthService } from './admin-growth.service';

/**
 * Ekran „Wzrost” panelu (ROADMAPA §5.8). Same agregaty z Prismy (moduł
 * globalny); aktywność dzienną zapisuje domena (`UserActivityService`),
 * panel tylko ją czyta.
 */
@Module({
  imports: [AdminCoreModule],
  controllers: [AdminGrowthController],
  providers: [AdminGrowthService],
})
export class AdminGrowthModule {}
