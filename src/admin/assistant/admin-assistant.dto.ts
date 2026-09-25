import { IsIn, IsOptional } from 'class-validator';
import type { ProfitPeriod, ReportStatus } from '../contract';
import { PROFIT_PERIODS } from './profit-math';
import { REPORT_STATUSES } from './report-view';

/** `GET /admin/assistant/profit?period=7|30|month` — bez parametru 30 dni (jak w panelu). */
export class ProfitQueryDto {
  @IsOptional()
  @IsIn(PROFIT_PERIODS)
  period?: ProfitPeriod;
}

/**
 * `PATCH /admin/assistant/reports/:id` — sam status, bez powodu: panel go nie
 * wysyła (decyzja moderatora to kliknięcie w kolejce), a `forbidNonWhitelisted`
 * odrzuciłby każde pole spoza tej klasy.
 */
export class ReportStatusDto {
  @IsIn(REPORT_STATUSES)
  status!: ReportStatus;
}
