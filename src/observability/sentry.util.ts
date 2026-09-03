import * as Sentry from '@sentry/nestjs';

/**
 * Błąd, którego nie przewidzieliśmy (5xx, wyjątek spoza `AppException`),
 * idzie do Sentry z kontekstem do odszukania w logach. Odpowiedzi 4xx to
 * nie błędy serwera i nie trafiają tu — inaczej Sentry tonąłby w „nie
 * znaleziono przepisu". Bez `SENTRY_DSN` to no-op.
 */
export function captureUnexpected(
  error: unknown,
  context: {
    requestId?: string;
    code?: string;
    transport: 'http' | 'ws';
    route?: string;
  },
): void {
  Sentry.captureException(error, {
    tags: {
      transport: context.transport,
      code: context.code ?? 'unknown',
      requestId: context.requestId ?? 'none',
    },
    extra: { route: context.route },
  });
}
