import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

export class HealthStepsRangeDto {
  @ApiProperty({ example: '2026-08-20' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'from musi mieć format YYYY-MM-DD',
  })
  from: string;

  @ApiProperty({ example: '2026-08-26' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'to musi mieć format YYYY-MM-DD',
  })
  to: string;
}
