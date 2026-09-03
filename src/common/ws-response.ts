import { Logger } from '@nestjs/common';
import { captureUnexpected } from '../observability/sentry.util';
import { randomUUID } from 'crypto';
import { mapError } from './error-contract';

export type WsSuccess<T> = { ok: true; data: T };
export type WsError = {
  ok: false;
  /** To samo co `message` — pole historyczne, czyta je 28 miejsc w iOS. */
  error: string;
  message: string;
  code: string;
  status: number;
  details?: string[];
  requestId: string;
};

type WsErrorObserver = (code: string, status: number) => void;

let errorObserver: WsErrorObserver | null = null;

/**
 * Hak dla metryk (`RequestMetricsService`). `wsRespond` jest wolną funkcją bez
 * DI, więc obserwator wpina się przy starcie modułu observability.
 */
export function setWsErrorObserver(observer: WsErrorObserver | null): void {
  errorObserver = observer;
}

const logger = new Logger('WsRespond');

/**
 * Opakowuje handler WebSocketu w kopertę ack.
 *
 * Błąd przechodzi przez ten sam `mapError`, co filtr HTTP: klient dostaje
 * `code` (po nim decyduje), `message`/`error` do pokazania, `status`,
 * opcjonalne `details` i `requestId`, którym da się odnaleźć wpis w logu.
 * Surowy komunikat Prismy albo `Error` nigdy nie wychodzi na drut — trafia
 * do logu razem z `requestId`.
 */
export async function wsRespond<T>(
  action: () => Promise<T>,
  meta?: { event?: string },
): Promise<WsSuccess<T> | WsError> {
  try {
    return { ok: true, data: await action() };
  } catch (error: unknown) {
    const requestId = randomUUID();
    const { contract, log } = mapError(error);

    if (log) {
      const line = `${meta?.event ?? 'ws'} ${contract.status} ${contract.code} requestId=${requestId}: ${log.message}`;
      if (log.level === 'error') {
        logger.error(line, log.stack);
        captureUnexpected(error, {
          code: contract.code,
          transport: 'ws',
          requestId,
        });
      } else {
        logger.warn(line);
      }
    }
    errorObserver?.(contract.code, contract.status);

    return {
      ok: false,
      error: contract.message,
      message: contract.message,
      code: contract.code,
      status: contract.status,
      ...(contract.details ? { details: contract.details } : {}),
      requestId,
    };
  }
}
