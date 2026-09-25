import { IsString, MaxLength, MinLength } from 'class-validator';
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
