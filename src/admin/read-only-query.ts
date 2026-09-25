import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException } from '../common/app-exception';
import type { PrismaService } from '../prisma/prisma.service';

/** Sufit jednego zapytania panelu. Agregaty liczą się na żywo (bez `AdminDailyStat`). */
export const ADMIN_STATEMENT_TIMEOUT_MS = 8_000;

/**
 * Odczyt panelu w transakcji TYLKO DO ODCZYTU z `statement_timeout`.
 *
 * Panel liczy agregaty na produkcyjnej bazie przy każdym otwarciu ekranu —
 * zapytanie, które się rozjedzie (brak indeksu, dziesięć razy więcej wierszy
 * niż dziś), nie może trzymać połączenia z puli minutami i dławić aplikacji.
 * `SET LOCAL` obowiązuje wyłącznie w tej transakcji, więc połączenie wraca
 * do puli bez zmian. `READ ONLY` to druga linia obrony: serwis odczytu, który
 * przez pomyłkę coś zapisze, dostanie błąd z bazy, a nie cichą zmianę.
 *
 * Przekroczenie czasu wychodzi jako 503 `SERVICE_UNAVAILABLE` z ludzkim
 * komunikatem, a nie 500.
 */
export async function readOnlyQuery<T>(
  prisma: PrismaService,
  run: (tx: Prisma.TransactionClient) => Promise<T>,
  timeoutMs: number = ADMIN_STATEMENT_TIMEOUT_MS,
): Promise<T> {
  const ms = Math.max(100, Math.floor(timeoutMs));
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${ms}`);
        return run(tx);
      },
      { timeout: ms + 2_000, maxWait: 5_000 },
    );
  } catch (error) {
    if (isStatementTimeout(error)) {
      throw new AppException(
        'SERVICE_UNAVAILABLE',
        'Zapytanie panelu trwało za długo. Spróbuj ponownie za chwilę.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    throw error;
  }
}

/** Postgres 57014 (`query_canceled` po `statement_timeout`) w dowolnym opakowaniu Prismy. */
export function isStatementTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  const text = `${typeof code === 'string' ? code : ''} ${error.message}`;
  return (
    text.includes('57014') ||
    text.includes('statement timeout') ||
    text.includes('canceling statement due to')
  );
}
