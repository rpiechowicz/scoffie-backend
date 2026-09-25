import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import type {
  GdprChannel,
  GdprCloseInput,
  GdprCreateInput,
  GdprExtendInput,
  GdprFilters,
  GdprKind,
  GdprStatusInput,
  GdprUpdateInput,
} from '../contract';
import { GDPR_CHANNELS, GDPR_KINDS } from './gdpr-rules';

const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Pusta notatka = brak notatki (`null` czyści pole). */
const note = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() || null : value;

export class AdminGdprQueryDto implements GdprFilters {
  @IsOptional()
  @IsIn(['open', 'closed', 'all'])
  state?: 'open' | 'closed' | 'all';

  @IsOptional()
  @IsIn(GDPR_KINDS)
  kind?: GdprKind;
}

export class AdminGdprCreateDto implements GdprCreateInput {
  @IsIn(GDPR_KINDS)
  kind!: GdprKind;

  @IsIn(GDPR_CHANNELS)
  channel!: GdprChannel;

  @IsOptional()
  @IsISO8601({ strict: true })
  receivedAt?: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(320)
  requesterEmail!: string;

  @IsOptional()
  @IsUUID()
  userId?: string | null;

  @IsOptional()
  @Transform(note)
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class AdminGdprUpdateDto implements GdprUpdateInput {
  @IsOptional()
  @IsUUID()
  userId?: string | null;

  @IsOptional()
  @Transform(note)
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class AdminGdprStatusDto implements GdprStatusInput {
  @IsIn(['OPEN', 'IN_PROGRESS'])
  status!: 'OPEN' | 'IN_PROGRESS';
}

export class AdminGdprExtendDto implements GdprExtendInput {
  @Transform(trimmed)
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}

export class AdminGdprCloseDto implements GdprCloseInput {
  @IsIn(['DONE', 'REJECTED'])
  status!: 'DONE' | 'REJECTED';

  @Transform(trimmed)
  @IsString()
  @MinLength(5)
  @MaxLength(2000)
  resolution!: string;
}
