import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export const STEP_SOURCES = ['APPLE_HEALTH', 'GARMIN'] as const;
export type StepSource = (typeof STEP_SOURCES)[number];

export class DailyStepsEntryDto {
  // Data liczona po stronie telefonu (lokalna strefa użytkownika) i przesyłana
  // jako goły string — serwer na Railway żyje w UTC i nie wolno mu jej ruszać.
  @ApiProperty({ example: '2026-08-26' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'date musi mieć format YYYY-MM-DD',
  })
  date: string;

  // 200 000 to sufit sanity-check: nikt tyle nie chodzi, a Zdrowie potrafi
  // dostać śmieciowe próbki od aplikacji trzecich.
  @ApiProperty({ example: 8421 })
  @IsInt()
  @Min(0)
  @Max(200_000)
  steps: number;

  @ApiProperty({ example: 10_000 })
  @IsInt()
  @Min(1)
  @Max(100_000)
  stepsGoal: number;

  @ApiProperty({ enum: STEP_SOURCES })
  @IsIn(STEP_SOURCES)
  source: StepSource;
}

export class SyncHealthStepsDto {
  // 14 > okno ~7 dni — zapas na zmiany stref czasowych, bez otwierania furtki
  // na hurtowy backfill, którego celowo nie wspieramy.
  @ApiProperty({ type: [DailyStepsEntryDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(14)
  @ValidateNested({ each: true })
  @Type(() => DailyStepsEntryDto)
  entries: DailyStepsEntryDto[];
}
