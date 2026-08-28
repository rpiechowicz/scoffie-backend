import { HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppErrorCode } from './app-error-code';
import { AppException, AppExceptionResponse } from './app-exception';

/**
 * Jeden kontrakt błędu dla HTTP i WebSocketu.
 *
 * Dotąd na drucie żyły trzy kształty (`AppException` → `{code, message}`,
 * goły wyjątek Nesta → `{statusCode, message, error}`, `ValidationPipe` →
 * `{statusCode, message: string[], error}`), a `wsRespond` oddawał klientowi
 * surowy `error.message` Prismy przy każdym nieobsłużonym błędzie. Ten moduł
 * jest jedynym miejscem, które zamienia „cokolwiek poleciało" na
 * `{ code, message, status, details? }` — filtr HTTP i `wsRespond` tylko go
 * opakowują.
 */

export type WireErrorCode = AppErrorCode | 'HTTP_ERROR';

export type ErrorContract = {
  code: WireErrorCode;
  message: string;
  status: number;
  details?: string[];
};

export type ErrorLog = {
  level: 'warn' | 'error';
  message: string;
  stack?: string;
};

export type MappedError = {
  contract: ErrorContract;
  /** Co zalogować po stronie serwera; `null` dla spodziewanych 4xx. */
  log: ErrorLog | null;
};

export type HttpErrorBody = {
  code: WireErrorCode;
  message: string;
  details?: string[];
  requestId: string;
};

export const INTERNAL_ERROR_MESSAGE =
  'Wystąpił błąd serwera. Spróbuj ponownie za chwilę.';

export const STATUS_CODE_MAP: Readonly<Record<number, WireErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'VALIDATION_ERROR',
  [HttpStatus.TOO_MANY_REQUESTS]: 'TOO_MANY_REQUESTS',
  [HttpStatus.BAD_GATEWAY]: 'SERVICE_UNAVAILABLE',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'SERVICE_UNAVAILABLE',
};

/** Prisma: kody, które mają czytelne znaczenie dla klienta. Komunikaty stałe — tekst Prismy niesie nazwy modeli i kolumn. */
const PRISMA_CODE_MAP: Readonly<
  Record<string, { code: AppErrorCode; message: string; status: number }>
> = {
  P2002: {
    code: 'CONFLICT',
    message: 'Taki rekord już istnieje.',
    status: HttpStatus.CONFLICT,
  },
  P2025: {
    code: 'NOT_FOUND',
    message: 'Nie znaleziono rekordu.',
    status: HttpStatus.NOT_FOUND,
  },
  P2003: {
    code: 'VALIDATION_ERROR',
    message: 'Nieprawidłowe odwołanie do powiązanego rekordu.',
    status: HttpStatus.BAD_REQUEST,
  },
};

function readHttpMessage(
  response: unknown,
  fallback: string,
): { message: string; details?: string[] } {
  if (typeof response === 'string') {
    return { message: response };
  }
  if (response && typeof response === 'object' && 'message' in response) {
    const message = (response as { message?: unknown }).message;
    if (Array.isArray(message)) {
      const details = message.map((entry) => String(entry));
      return { message: details.join(', '), details };
    }
    if (typeof message === 'string') {
      return { message };
    }
  }
  return { message: fallback };
}

/** Obiekt z body-parsera / http-errors: `{ statusCode, message, type? }` bez klasy Nesta. */
function isHttpErrorLike(
  error: unknown,
): error is { statusCode: number; message?: string } {
  if (!error || typeof error !== 'object') return false;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 600;
}

function internalError(error: unknown): MappedError {
  const message =
    error instanceof Error ? error.message : `Non-error thrown: ${String(error)}`;
  return {
    contract: {
      code: 'INTERNAL_ERROR',
      message: INTERNAL_ERROR_MESSAGE,
      status: HttpStatus.INTERNAL_SERVER_ERROR,
    },
    log: {
      level: 'error',
      message,
      stack: error instanceof Error ? error.stack : undefined,
    },
  };
}

export function mapError(error: unknown): MappedError {
  // 1. Własny wyjątek — kod i komunikat są już decyzją kodu domenowego.
  if (error instanceof AppException) {
    const response = error.getResponse() as AppExceptionResponse;
    const status = error.getStatus();
    return {
      contract: {
        code: response.code,
        message: response.message,
        status,
        ...(response.details ? { details: response.details } : {}),
      },
      log:
        status >= 500
          ? { level: 'error', message: response.message, stack: error.stack }
          : null,
    };
  }

  // 2. Goły wyjątek Nesta (także z ValidationPipe): kod ze statusu.
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const { message, details } = readHttpMessage(
      error.getResponse(),
      error.message,
    );
    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      return internalError(error);
    }
    if (status >= 500) {
      return {
        contract: {
          code: STATUS_CODE_MAP[status] ?? 'HTTP_ERROR',
          message,
          status,
        },
        log: { level: 'error', message, stack: error.stack },
      };
    }
    const code =
      details && status === HttpStatus.BAD_REQUEST
        ? 'VALIDATION_ERROR'
        : (STATUS_CODE_MAP[status] ?? 'HTTP_ERROR');
    return {
      contract: { code, message, status, ...(details ? { details } : {}) },
      log: null,
    };
  }

  // 3. Prisma: znane kody dostają czytelny sens, tekst Prismy zostaje w logu.
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const known = PRISMA_CODE_MAP[error.code];
    if (!known) {
      return internalError(error);
    }
    return {
      contract: { ...known },
      log: {
        level: 'warn',
        message: `Prisma ${error.code} ${JSON.stringify(error.meta ?? {})}`,
      },
    };
  }

  // 4. body-parser (za duże body, zepsuty JSON) — status jest, klasy nie ma.
  if (isHttpErrorLike(error)) {
    const status = error.statusCode;
    return {
      contract: {
        code: STATUS_CODE_MAP[status] ?? 'HTTP_ERROR',
        message: 'Nieprawidłowe żądanie.',
        status,
      },
      log: null,
    };
  }

  // 5. Reszta (w tym rzut nie-Error i PrismaClientValidationError) — nigdy
  //    nie pokazujemy klientowi, co poszło nie tak w środku.
  return internalError(error);
}

export function toHttpBody(
  contract: ErrorContract,
  requestId: string,
): HttpErrorBody {
  return {
    code: contract.code,
    message: contract.message,
    ...(contract.details ? { details: contract.details } : {}),
    requestId,
  };
}
