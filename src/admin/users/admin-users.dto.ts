import { Transform } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { UserListFilters } from '../contract';

/**
 * Flagi przychodzą w adresie jako napisy (`?onboarding=true`). `true` /
 * `false` zamieniamy na boolean, a wszystko inne zostaje napisem i odbija się
 * od `@IsBoolean` — literówka w filtrze ma dać 400, a nie po cichu pełną listę.
 */
const queryBoolean = ({ value }: { value: unknown }): unknown => {
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'true') return true;
    if (lowered === 'false') return false;
  }
  return value;
};

/** `GET /admin/users` — nazwy pól 1:1 z `UserListFilters` kontraktu. */
export class AdminUserListQueryDto implements UserListFilters {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  onboarding?: boolean;

  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  subscribed?: boolean;

  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  active7?: boolean;

  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  noHousehold?: boolean;
}

/** `GET /admin/search?q=` */
export class AdminSearchQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}

/**
 * `POST /admin/users/:id/devices/:deviceId/test-push`. Na urządzenie obcej
 * osoby oba pola są wymagane — pilnuje tego serwis (zależy od konta).
 */
export class AdminPushTestDto {
  @IsOptional()
  @IsBoolean()
  @Equals(true)
  confirmForeign?: boolean;

  @IsOptional()
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason?: string;
}

/** Powód akcji — trafia do `AdminAuditLog.reason`. */
export class AdminReasonDto {
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}
