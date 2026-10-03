import { Module } from '@nestjs/common';
import { AdminCoreModule } from '../admin-core.module';
import { AdminCookController } from './admin-cook.controller';
import { AdminCookFeedbackService } from './admin-cook-feedback.service';
import { AdminCookScenariosService } from './admin-cook-scenarios.service';

/**
 * Ekrany Gotuj w panelu: oceny gotowania i scenariusze przepisów. Zapis
 * scenariuszy idzie przez `publishCookScenario` domeny i audyt panelu.
 */
@Module({
  imports: [AdminCoreModule],
  controllers: [AdminCookController],
  providers: [AdminCookFeedbackService, AdminCookScenariosService],
})
export class AdminCookModule {}
