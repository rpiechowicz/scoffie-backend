import { HttpException, HttpStatus } from '@nestjs/common';
import { AppErrorCode } from './app-error-code';

export type WsSuccess<T> = { ok: true; data: T };
export type WsError = {
  ok: false;
  error: string;
  code: string;
  status?: number;
};

const STATUS_CODE_MAP: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'UNPROCESSABLE_ENTITY',
  [HttpStatus.TOO_MANY_REQUESTS]: 'TOO_MANY_REQUESTS',
};

function extractMessage(response: unknown): string {
  if (typeof response === 'string') {
    return response;
  }
  if (response && typeof response === 'object' && 'message' in response) {
    const message = (response as { message?: unknown }).message;
    if (Array.isArray(message)) {
      return message.join(', ');
    }
    if (typeof message === 'string') {
      return message;
    }
  }
  return 'Unexpected error';
}

function extractCode(response: unknown): AppErrorCode | null {
  if (!response || typeof response !== 'object') {
    return null;
  }

  if ('code' in response && typeof (response as { code?: unknown }).code === 'string') {
    return (response as { code: AppErrorCode }).code;
  }

  return null;
}

export async function wsRespond<T>(action: () => Promise<T>): Promise<WsSuccess<T> | WsError> {
  try {
    return { ok: true, data: await action() };
  } catch (error: unknown) {
    if (error instanceof HttpException) {
      const status = error.getStatus();
      const response = error.getResponse();
      return {
        ok: false,
        error: extractMessage(response),
        code: extractCode(response) ?? STATUS_CODE_MAP[status] ?? 'HTTP_ERROR',
        status,
      };
    }

    const message = error instanceof Error ? error.message : 'Unexpected error';
    return { ok: false, error: message, code: 'INTERNAL_ERROR', status: 500 };
  }
}
