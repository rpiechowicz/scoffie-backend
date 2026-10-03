import { Get, Query } from '@nestjs/common';
import { AdminController } from '../admin-controller.decorator';
import { AdminRequires } from '../admin.decorators';
import { FeedbackQueryDto } from '../assistant/admin-assistant.dto';
import type { CookFeedbackData } from '../contract';
import { AdminCookFeedbackService } from './admin-cook-feedback.service';

/**
 * Gotuj w panelu: oceny gotowania (3.10.2026). Odczyt — `catalog.read`,
 * bo sygnał służy poprawie scenariuszy przepisów.
 */
@AdminController('cook')
export class AdminCookController {
  constructor(private readonly feedback: AdminCookFeedbackService) {}

  /** Oceny gotowania — zakładka „Gotuj” w dziale „Oceny”. */
  @Get('feedback')
  @AdminRequires('catalog.read')
  feedbackOverview(
    @Query() query: FeedbackQueryDto,
  ): Promise<CookFeedbackData> {
    return this.feedback.overview(query.period ?? '30');
  }
}
