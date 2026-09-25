import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';

/**
 * Kody błędów logowania i uprawnień panelu (kontrakt z frontem:
 * `docs/plans/scoffie-admin/API-AUTH.md`).
 *
 * Osobna lista, NIE `APP_ERROR_CODES`: tamta ma parytet z kopiami w iOS
 * (`pnpm check:error-parity`), a tych kodów aplikacja nigdy nie zobaczy.
 */
export const ADMIN_AUTH_ERROR_CODES = [
  'INVALID_CODE',
  'PASSKEY_FAILED',
  'LOCKED',
  'STEP_UP_REQUIRED',
  'LAST_METHOD',
  'NOT_ALLOWED',
  'PASSKEY_EXISTS',
  'CROSS_SITE',
  'UNSUPPORTED_MEDIA_TYPE',
] as const;
export type AdminAuthErrorCode = (typeof ADMIN_AUTH_ERROR_CODES)[number];

const STATUS: Record<AdminAuthErrorCode, HttpStatus> = {
  INVALID_CODE: HttpStatus.UNAUTHORIZED,
  PASSKEY_FAILED: HttpStatus.UNAUTHORIZED,
  LOCKED: HttpStatus.TOO_MANY_REQUESTS,
  STEP_UP_REQUIRED: HttpStatus.FORBIDDEN,
  NOT_ALLOWED: HttpStatus.FORBIDDEN,
  LAST_METHOD: HttpStatus.CONFLICT,
  PASSKEY_EXISTS: HttpStatus.CONFLICT,
  CROSS_SITE: HttpStatus.FORBIDDEN,
  UNSUPPORTED_MEDIA_TYPE: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
};

const DEFAULT_MESSAGE: Record<AdminAuthErrorCode, string> = {
  INVALID_CODE: 'Nieprawidłowy kod.',
  PASSKEY_FAILED: 'Nie udało się potwierdzić klucza dostępu.',
  LOCKED: 'Za dużo nieudanych prób. Spróbuj ponownie później.',
  STEP_UP_REQUIRED: 'Ta akcja wymaga ponownego potwierdzenia tożsamości.',
  NOT_ALLOWED: 'Ta operacja nie jest teraz dozwolona.',
  LAST_METHOD: 'To ostatni sposób logowania — najpierw dodaj inny.',
  PASSKEY_EXISTS: 'Ten klucz jest już zapisany.',
  CROSS_SITE: 'Żądanie spoza panelu zostało odrzucone.',
  UNSUPPORTED_MEDIA_TYPE: 'Panel przyjmuje wyłącznie JSON.',
};

type AdminAuthBody = {
  code: AdminAuthErrorCode;
  message: string;
  lockedUntil?: string;
};

/**
 * Błąd logowania / uprawnień panelu. Ciało: `{ code, message, lockedUntil?,
 * requestId }` — kształt kontraktu aplikacji plus `lockedUntil` przy LOCKED.
 */
export class AdminAuthException extends HttpException {
  constructor(
    code: AdminAuthErrorCode,
    message: string = DEFAULT_MESSAGE[code],
    extra: { lockedUntil?: Date | null } = {},
  ) {
    super(
      {
        code,
        message,
        ...(extra.lockedUntil
          ? { lockedUntil: extra.lockedUntil.toISOString() }
          : {}),
      } satisfies AdminAuthBody,
      STATUS[code],
    );
  }

  get code(): AdminAuthErrorCode {
    return (this.getResponse() as AdminAuthBody).code;
  }
}

/**
 * Filtr WYŁĄCZNIE dla `AdminAuthException`, zakładany na kontrolery panelu.
 * Każdy inny wyjątek — w tym ukryte 404 z bramki — idzie dalej do globalnego
 * `AppExceptionFilter`, więc tamten kontrakt (i nieodróżnialność 404) zostaje
 * nietknięty.
 */
@Catch(AdminAuthException)
export class AdminAuthExceptionFilter implements ExceptionFilter {
  catch(exception: AdminAuthException, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request & { requestId?: string }>();
    const res = http.getResponse<Response>();
    const header = req.headers['x-request-id'];
    const requestId =
      req.requestId ??
      (Array.isArray(header) ? header[0] : header) ??
      randomUUID();
    req.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    res
      .status(exception.getStatus())
      .json({ ...(exception.getResponse() as AdminAuthBody), requestId });
  }
}
