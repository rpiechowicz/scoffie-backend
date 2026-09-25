import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { RuntimeSettingUpdate } from '../contract';

/** `PUT /admin/settings/:key` — wartość jak w zmiennej środowiskowej. */
export class AdminRuntimeSettingDto implements RuntimeSettingUpdate {
  @IsString()
  @MaxLength(10_000)
  value!: string;

  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}

/** `GET /admin/settings/changes?days=` — okno w dniach (domyślnie 90). */
export class SettingChangesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(400)
  days?: number;
}
