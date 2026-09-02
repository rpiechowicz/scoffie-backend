import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { IsMondayDate } from './agent-date.validators';

/** Kontekst chipów: dom obowiązkowo, tydzień opcjonalnie (do etykiety). */
export class ContextQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  householdId: string;

  @ApiPropertyOptional({ example: '2026-08-31' })
  @IsOptional()
  @IsMondayDate()
  weekStart?: string;
}
