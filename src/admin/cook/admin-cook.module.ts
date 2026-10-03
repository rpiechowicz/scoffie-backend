import { Module } from '@nestjs/common';
import { AdminCoreModule } from '../admin-core.module';
import { AdminCookController } from './admin-cook.controller';
import { AdminCookFeedbackService } from './admin-cook-feedback.service';

/**
 * Ekrany Gotuj w panelu. Same odczyty przez Prismę (moduł globalny) — domena
 * scenariuszy nie ma tu nic do dodania.
 */
@Module({
  imports: [AdminCoreModule],
  controllers: [AdminCookController],
  providers: [AdminCookFeedbackService],
})
export class AdminCookModule {}
