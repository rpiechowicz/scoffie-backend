import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { AdminPermission } from './admin-permissions';
import type { AdminAccessContext, AdminRequest } from './admin-request';
import type { ResolvedAdminSession } from './auth/admin-sessions.service';

/**
 * Czy trasa potrzebuje sesji panelu:
 *   - `required` (domyślnie) — bez sesji 404 jak brak trasy,
 *   - `optional` — sesja, jeśli jest (np. rejestracja passkeya w bootstrapie),
 *   - `none` — tylko bramka Access (logowanie, stan logowania).
 */
export type AdminSessionMode = 'none' | 'optional' | 'required';
export const ADMIN_SESSION_MODE = 'admin:session-mode';
export const AdminSessionMode = (mode: AdminSessionMode) =>
  SetMetadata(ADMIN_SESSION_MODE, mode);

/**
 * Trasa dostępna także dla sesji otwartej kodem odzyskiwania, zanim admin
 * skonfiguruje nowy passkey albo TOTP. Wszystko inne dostaje wtedy 403
 * `NOT_ALLOWED`.
 */
export const ADMIN_ALLOW_REENROLL = 'admin:allow-reenroll';
export const AllowDuringReenroll = () =>
  SetMetadata(ADMIN_ALLOW_REENROLL, true);

/**
 * Akcja, która boli (ROADMAPA §4): bez potwierdzenia passkeyem albo TOTP
 * w ostatnich 5 minutach — 403 `STEP_UP_REQUIRED`, rzucane w guardzie, czyli
 * PRZED walidacją ciała i przed jakimkolwiek skutkiem.
 */
export const ADMIN_STEP_UP = 'admin:step-up';
export const RequireStepUp = () => SetMetadata(ADMIN_STEP_UP, true);

export const ADMIN_PERMISSION = 'admin:permission';
export const AdminRequires = (permission: AdminPermission) =>
  SetMetadata(ADMIN_PERMISSION, permission);

/** Kontekst bramki (adres z Access, IP, kraj) — ustawia `AdminGuard`. */
export const AdminAccess = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AdminAccessContext => {
    const req = context.switchToHttp().getRequest<AdminRequest>();
    if (!req.adminAccess) {
      // Trasa panelu bez `AdminGuard` to błąd programisty, nie klienta.
      throw new Error('AdminAccess bez AdminGuard');
    }
    return req.adminAccess;
  },
);

/** Sesja panelu albo `null` (trasy `optional` / `none`). */
export const CurrentAdminSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ResolvedAdminSession | null =>
    context.switchToHttp().getRequest<AdminRequest>().adminSession ?? null,
);
