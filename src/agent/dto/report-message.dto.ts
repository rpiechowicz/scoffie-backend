import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/** Powody z ekranu iOS — cztery, żeby dało się je odhaczyć jednym dotknięciem. */
export const AGENT_REPORT_REASONS = [
  /** Błąd merytoryczny (zły przepis, zła liczba, zignorowany alergen). */
  'WRONG',
  /** Odpowiedź potencjalnie szkodliwa dla zdrowia. */
  'UNSAFE',
  /** Treść obraźliwa lub nie na temat. */
  'OFFENSIVE',
  'OTHER',
] as const;
export const AGENT_REPORT_REASON_VALUES: string[] = [...AGENT_REPORT_REASONS];

export class ReportMessageDto {
  @ApiProperty({ enum: AGENT_REPORT_REASON_VALUES })
  @IsIn(AGENT_REPORT_REASON_VALUES)
  reason: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}
