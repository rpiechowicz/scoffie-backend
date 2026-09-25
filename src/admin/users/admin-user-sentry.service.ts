import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { SentryUserState } from '../contract';
import { IntegrationCache } from '../integrations/integration-fetch';
import { missingSentry, readSentryEnv } from '../integrations/integrations-env';
import { fetchSentryUser } from '../integrations/sentry.client';
import { userNotFound } from './admin-users.service';

/** Karta osoby odświeża się rzadko, a limity API Sentry są niskie. */
export const USER_SENTRY_TTL_MS = 60_000;

/**
 * Błędy Sentry jednej osoby na jej karcie (`GET /admin/users/:id/sentry`).
 *
 * Uprawnienie `users.read`, nie `ops.read`: to część karty osoby — ktoś,
 * kto obsługuje zgłoszenie „apka mi się wywala”, potrzebuje błędów TEJ
 * osoby, a nie wglądu w całą infrastrukturę (Railway, wdrożenia, logi).
 * Zakres danych jest ten sam co reszta karty: jedna osoba, którą admin
 * i tak już widzi.
 *
 * Brak `ADMIN_SENTRY_TOKEN` = `off`, awaria Sentry = `error` — nigdy 500.
 * Pamięć 60 s per osoba, wspólna dla równoległych żądań.
 */
@Injectable()
export class AdminUserSentryService {
  private readonly cache = new IntegrationCache();

  constructor(private readonly prisma: PrismaService) {}

  async forUser(
    userId: string,
    fetchImpl: typeof fetch = globalThis.fetch,
  ): Promise<SentryUserState> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) throw userNotFound();

    const env = readSentryEnv();
    const missing = missingSentry(env);
    if (missing.length > 0) return { status: 'off', missing };
    return this.cache.get(`sentry-user:${userId}`, USER_SENTRY_TTL_MS, () =>
      fetchSentryUser(env, userId, fetchImpl),
    );
  }
}
