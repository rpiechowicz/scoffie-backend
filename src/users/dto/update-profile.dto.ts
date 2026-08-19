import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Partial-update payload for `users:profile:update`. Sent during the
 * first-login welcome flow (step 1 — Profile) and any later edits from
 * Settings. Every field is optional; the service merges into the user
 * row, leaving omitted fields untouched.
 *
 * Validation bounds match the iOS UI:
 *   - displayName: 1…64 chars (matches the existing column)
 *   - yearOfBirth: 1900…current year (server clamps)
 *   - heightCm: 80…260
 *   - weightKg: 30…300
 */
export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Rafał' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  displayName?: string;

  @ApiPropertyOptional({ example: 1992, minimum: 1900, maximum: 2100 })
  @IsOptional()
  @IsInt()
  @Min(1900)
  @Max(2100)
  yearOfBirth?: number;

  @ApiPropertyOptional({ example: 178, minimum: 80, maximum: 260 })
  @IsOptional()
  @IsInt()
  @Min(80)
  @Max(260)
  heightCm?: number;

  @ApiPropertyOptional({ example: 74, minimum: 30, maximum: 300 })
  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(300)
  weightKg?: number;
}
