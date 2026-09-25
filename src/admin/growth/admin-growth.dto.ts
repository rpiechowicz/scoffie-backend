import { IsIn, IsOptional } from 'class-validator';
import type { GrowthPeriod } from '../contract';
import { GROWTH_PERIODS } from './growth-math';

/** `GET /admin/growth?period=7|30|90` — bez parametru 30 dni. */
export class GrowthQueryDto {
  @IsOptional()
  @IsIn(GROWTH_PERIODS)
  period?: GrowthPeriod;
}
