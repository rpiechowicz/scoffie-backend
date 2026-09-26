import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { serializableTransactionOptions } from '../../prisma/database-config';

/// Detects Prisma's `P2034` "could not serialize access due to concurrent
/// update" error. Used to know when a serializable retry is worthwhile.
export function isSerializableConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2034'
  );
}

/// Runs `operation` inside a SERIALIZABLE transaction. On a serializable
/// conflict (P2034), retries up to `maxRetries` times before re-throwing.
/// All other errors propagate immediately.
export async function runSerializable<T>(
  prisma: PrismaService,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
  maxRetries = 2,
): Promise<T> {
  let attempts = 0;
  while (true) {
    try {
      return await prisma.$transaction(async (tx) => operation(tx), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        // `DB_SERIALIZABLE_TIMEOUT_MS` / `_MAX_WAIT_MS`; puste = domyślne
        // Prismy (5 s / 2 s), jak dotąd — Etap 4D.
        ...serializableTransactionOptions(),
      });
    } catch (error) {
      if (isSerializableConflict(error) && attempts < maxRetries) {
        attempts += 1;
        continue;
      }
      throw error;
    }
  }
}
