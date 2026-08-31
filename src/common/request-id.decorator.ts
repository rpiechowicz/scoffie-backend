import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { randomUUID } from 'crypto';

type RequestWithId = {
  requestId?: string;
  headers?: Record<string, string | string[] | undefined>;
};

/**
 * `requestId` bieżącego żądania — ten sam, który wychodzi w nagłówku
 * `x-request-id` i w każdym błędzie (`toHttpBody`).
 *
 * Nadaje go `RequestLoggingInterceptor` (albo `AppExceptionFilter`, gdy guard
 * odrzucił żądanie wcześniej). Interceptory biegną przed handlerem, więc w
 * kontrolerze `req.requestId` już jest; fallback na nagłówek i nowy UUID
 * istnieje dla wywołań spoza pełnego potoku (testy jednostkowe kontrolera).
 *
 * Asystent zapisuje go w `AgentTurn.requestId`: po zgłoszeniu „tura padła"
 * jeden identyfikator z telefonu prowadzi do logu żądania, tury i wpisu w
 * `AiUsage`.
 */
export const RequestId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<RequestWithId>();
    if (request.requestId) return request.requestId;
    const header = request.headers?.['x-request-id'];
    const fromHeader = Array.isArray(header) ? header[0] : header;
    return fromHeader ?? randomUUID();
  },
);
