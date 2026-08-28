import { HttpException, HttpStatus } from '@nestjs/common';
import { AppErrorCode } from './app-error-code';

export type AppExceptionResponse = {
  code: AppErrorCode;
  message: string;
  /** Lista czytelnych szczegółów (np. pola walidacji). Zawsze tablica stringów — iOS dekoduje `[String]?`. */
  details?: string[];
};

export class AppException extends HttpException {
  constructor(
    code: AppErrorCode,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
    details?: string[],
  ) {
    super(
      details === undefined
        ? ({ code, message } satisfies AppExceptionResponse)
        : ({ code, message, details } satisfies AppExceptionResponse),
      status,
    );
  }

  get code(): AppErrorCode {
    return (this.getResponse() as AppExceptionResponse).code;
  }

  get details(): string[] | undefined {
    return (this.getResponse() as AppExceptionResponse).details;
  }
}
