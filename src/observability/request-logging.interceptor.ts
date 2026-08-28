import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Observable } from 'rxjs';
import { finalize, tap } from 'rxjs/operators';
import { Request, Response } from 'express';
import { RequestMetricsService } from './request-metrics.service';
import { mapError } from '../common/error-contract';

type RequestWithUser = Request & {
  user?: { id?: string };
  requestId?: string;
};

@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RequestLoggingInterceptor.name);

  constructor(private readonly metrics: RequestMetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const req = http.getRequest<RequestWithUser>();
    const res = http.getResponse<Response>();

    const requestIdHeader = req.headers['x-request-id'];
    const requestId =
      (Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader) ||
      randomUUID();

    req.requestId = requestId;
    res.setHeader('x-request-id', requestId);

    const method = req.method;
    const routePath =
      (req.route?.path as string | undefined) ||
      req.path ||
      req.originalUrl ||
      '/';
    const routeKey = `${method} ${routePath}`;
    const userId = req.user?.id ?? null;
    const startedAt = process.hrtime.bigint();

    // `finalize` biegnie ZANIM filtr wyjątków ustawi status odpowiedzi, więc
    // rzucone błędy HTTP liczyły się w metrykach jako 200. Status błędu
    // bierzemy z tego samego mapera, którego użyje filtr.
    let errorStatus: number | null = null;

    return next.handle().pipe(
      tap({
        error: (error: unknown) => {
          errorStatus = mapError(error).contract.status;
        },
      }),
      finalize(() => {
        const durationMs =
          Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        const statusCode = errorStatus ?? (res.statusCode || 500);

        this.metrics.record(routeKey, statusCode, durationMs);

        const message = `${method} ${req.originalUrl || routePath} ${statusCode} ${durationMs.toFixed(1)}ms`;
        const contextData = `requestId=${requestId} userId=${userId ?? '-'} ip=${req.ip ?? '-'} ua=${req.headers['user-agent'] ?? '-'}`;

        if (statusCode >= 500) {
          this.logger.error(`${message} ${contextData}`);
        } else if (statusCode >= 400) {
          this.logger.warn(`${message} ${contextData}`);
        } else {
          this.logger.log(`${message} ${contextData}`);
        }
      }),
    );
  }
}
