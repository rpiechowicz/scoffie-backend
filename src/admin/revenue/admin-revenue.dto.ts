import { IsIn, IsOptional } from 'class-validator';
import type { RevenuePeriod } from '../contract';
import { REVENUE_PERIODS } from './revenue';

/** `GET /admin/revenue?period=30|90|365` — bez parametru 30 dni. */
export class RevenueQueryDto {
  @IsOptional()
  @IsIn(REVENUE_PERIODS)
  period?: RevenuePeriod;
}
