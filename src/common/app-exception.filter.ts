import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { BaseWsExceptionFilter } from '@nestjs/websockets';
import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import { mapError, toHttpBody } from './error-contract';
import { redactUrl } from './redact-url';
import { captureUnexpected } from '../observability/sentry.util';

type RequestWithId = Request & { requestId?: string };

/**
 * Globalny filtr HTTP: każdy błąd wychodzi jako
 * `{ code, message, details?, requestId }` + nagłówek `x-request-id`.
 *
 * `requestId` filtr liczy SAM (z `req.requestId`, nagłówka albo nowego UUID),
 * bo guardy — `JwtAuthGuard` — odrzucają żądanie zanim
 * `RequestLoggingInterceptor` zdąży je nadać; bez tego 401 z guardu
 * wychodziłby bez identyfikatora, którego klient mógłby przytoczyć.
 *
 * Kontekst nie-HTTP (gateway bez `wsRespond`) idzie do domyślnego filtra
 * Nesta — wszystkie 47 handlerów WS i tak owija `wsRespond`, to tylko siatka.
 */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppExceptionFilter.name);
  private readonly wsFallback = new BaseWsExceptionFilter();

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      this.wsFallback.catch(exception, host);
      return;
    }

    const http = host.switchToHttp();
    const req = http.getRequest<RequestWithId>();
    const res = http.getResponse<Response>();

    const header = req.headers['x-request-id'];
    const requestId =
      req.requestId ??
      (Array.isArray(header) ? header[0] : header) ??
      randomUUID();
    req.requestId = requestId;

    const { contract, log } = mapError(exception);
    if (log) {
      const line = `${req.method} ${redactUrl(req.originalUrl ?? req.url)} ${contract.status} ${contract.code} requestId=${requestId}: ${log.message}`;
      if (log.level === 'error') {
        this.logger.error(line, log.stack);
        captureUnexpected(exception, {
          requestId,
          code: contract.code,
          transport: 'http',
          route: `${req.method} ${redactUrl(req.originalUrl ?? req.url)}`,
        });
      } else {
        this.logger.warn(line);
      }
    }

    res.setHeader('x-request-id', requestId);
    res.status(contract.status).json(toHttpBody(contract, requestId));
  }
}
