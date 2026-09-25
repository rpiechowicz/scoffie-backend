import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { FEATURE_FLAG_KEY_PATTERN } from '../../feature-flags/feature-flags.evaluate';
import type {
  FeatureFlagCreate,
  FeatureFlagUpdate,
  HouseholdFlagOverride,
} from '../contract';

/** `POST /admin/flags` */
export class AdminFeatureFlagCreateDto implements FeatureFlagCreate {
  @IsString()
  @Matches(FEATURE_FLAG_KEY_PATTERN, {
    message:
      'klucz: 2–64 znaki, małe litery, cyfry, „.”, „_”, „-”, zaczyna się literą',
  })
  key!: string;

  @IsString()
  @MaxLength(200)
  description!: string;

  @IsBoolean()
  enabled!: boolean;

  @IsInt()
  @Min(0)
  @Max(100)
  rolloutPercent!: number;

  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}

/** `PATCH /admin/flags/:key` */
export class AdminFeatureFlagUpdateDto implements FeatureFlagUpdate {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  rolloutPercent?: number;

  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}

/** `PUT /admin/flags/:key/households/:householdId` */
export class AdminHouseholdFlagOverrideDto implements HouseholdFlagOverride {
  @IsBoolean()
  enabled!: boolean;

  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}
