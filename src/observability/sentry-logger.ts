import { ConsoleLogger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';

/**
 * Logger Nesta, który pisze na stdout jak dotąd (Railway), a `warn`
 * i `error` dodatkowo wysyła do Sentry Logs — powiązane ze śladem żądania.
 *
 * Nie `consoleLoggingIntegration`: ConsoleLogger pisze wprost do
 * `process.stdout`, a przełączenie go na `console.*` (`forceConsole`) zmienia
 * wyjście w Railway i wysyła do Sentry kody kolorów ANSI. `log`/`debug` nie
 * wychodzą — linia na każde żądanie to wolumen bez wartości; od tego są ślady.
 *
 * Bez `SENTRY_LOGS=true` (`enableLogs`) `Sentry.logger.*` to no-op.
 * Czyszczenie treści (IP, UA, query, e-maile) robi `beforeSendLog`
 * w `instrument.ts` — obejmuje też logi wysłane z pominięciem tej klasy.
 */
export class SentryForwardingLogger extends ConsoleLogger {
  override warn(message: unknown, ...optionalParams: unknown[]): void {
    super.warn(message, ...optionalParams);
    forward('warn', message, optionalParams, this.context);
  }

  override error(message: unknown, ...optionalParams: unknown[]): void {
    super.error(message, ...optionalParams);
    forward('error', message, optionalParams, this.context);
  }
}

function forward(
  level: 'warn' | 'error',
  message: unknown,
  optionalParams: unknown[],
  ownContext: string | undefined,
): void {
  // `new Logger('X').warn(msg)` dociera tu jako `warn(msg, 'X')` — kontekst
  // jest ostatnim parametrem-napisem; stos przy `error` go poprzedza.
  const last = optionalParams[optionalParams.length - 1];
  const context =
    typeof last === 'string' && !last.includes('\n') ? last : ownContext;
  const text =
    message instanceof Error
      ? `${message.name}: ${message.message}`
      : typeof message === 'string'
        ? message
        : safeJson(message);
  Sentry.logger[level](text, context ? { 'logger.name': context } : {});
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
