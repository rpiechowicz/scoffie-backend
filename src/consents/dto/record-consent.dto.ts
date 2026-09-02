import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  CONSENT_ACTION_VALUES,
  CONSENT_KIND_VALUES,
} from '../../common/legal-documents';

export class RecordConsentDto {
  @ApiProperty({ enum: CONSENT_KIND_VALUES })
  @IsIn(CONSENT_KIND_VALUES)
  kind: string;

  @ApiProperty({ enum: CONSENT_ACTION_VALUES })
  @IsIn(CONSENT_ACTION_VALUES)
  action: string;

  /**
   * Wersja dokumentu, którą użytkownik WIDZIAŁ — klient podaje tę, którą
   * wyświetlił, nie „aktualną z serwera": dowód dotyczy konkretnego tekstu.
   */
  @ApiProperty({ example: '2026-09-02' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  documentVersion: string;

  @ApiPropertyOptional({ example: 'IOS_APP' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  source?: string;

  @ApiPropertyOptional({ example: '2.0 (74)' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  appVersion?: string;

  /** Kontekst dowodowy: w którym domu użytkownik klikał. */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  householdId?: string;
}
