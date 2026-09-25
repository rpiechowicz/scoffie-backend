import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { AuditFilters, AuditResult } from '../contract';

export const AUDIT_PAGE_DEFAULT = 50;
export const AUDIT_PAGE_MAX = 200;

const RESULTS: AuditResult[] = ['PENDING', 'SUCCESS', 'FAILED'];

/** `GET /admin/audit` — `action` i `result` 1:1 z `AuditFilters` kontraktu. */
export class AdminAuditQueryDto implements AuditFilters {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z0-9._-]+$/i)
  action?: string;

  @IsOptional()
  @IsIn(RESULTS)
  result?: AuditResult;

  /** `nextCursor` poprzedniej strony — sprawdzany w serwisie. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  before?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(AUDIT_PAGE_MAX)
  limit?: number;
}
