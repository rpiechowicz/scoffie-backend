import { ApiPropertyOptional } from '@nestjs/swagger';
import { Sex } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsNumber,
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
 * Od Fazy 0 te dekoratory FAKTYCZNIE działają także na WebSockecie —
 * `UsersService.updateProfile` woła `validateDto(UpdateProfileDto)` na
 * wejściu, więc 835 kg albo `sex: 'X'` kończą się VALIDATION_ERROR z listą
 * dozwolonych, a nie `PrismaClientValidationError` → 500.
 *
 * Validation bounds match the iOS UI:
 *   - displayName: 1…64 chars (kolumna nie ma limitu; 64 to kontrakt WS od
 *     Fazy 0 — do kroku 2 dłuższe nazwy zapisywały się bez błędu)
 *   - yearOfBirth: 1900…2100
 *   - heightCm: 80…260
 *   - weightKg: 30…300, z dokładnością do 0,1 kg
 *   - sex: enum Prismy `Sex` (MALE | FEMALE) — jedno źródło prawdy zamiast
 *     lokalnej kopii; opcjonalna, wchodzi tylko do wzoru na BMR
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

  @ApiPropertyOptional({ example: 83.5, minimum: 30, maximum: 300 })
  @IsOptional()
  // Jedno miejsce po przecinku — tyle, ile pokazuje każda domowa waga.
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(30)
  @Max(300)
  weightKg?: number;

  @ApiPropertyOptional({ enum: Sex, example: Sex.MALE })
  @IsOptional()
  @IsEnum(Sex)
  sex?: Sex;
}
