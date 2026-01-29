import { ApiProperty } from '@nestjs/swagger';
import { IsDateString } from 'class-validator';

export class CreateWeeklyPlanDto {
  @ApiProperty({ example: '2026-02-02' })
  @IsDateString()
  weekStart: string;
}
