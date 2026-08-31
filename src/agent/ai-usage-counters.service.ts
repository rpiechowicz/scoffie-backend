import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Klient Prismy albo klient transakcji — liczniki muszą dać się naliczyć
 * WEWNĄTRZ transakcji, która zakłada turę (inaczej kwota i tura mogłyby się
 * rozjechać przy awarii między zapisami).
 */
export type UsageCounterClient = Prisma.TransactionClient | PrismaService;

/** Rodzaje liczników — jeden wiersz `AiUsageCounter` na (scope, okres, rodzaj). */
export const USAGE_KINDS = ['messages', 'plans', 'costMicroUsd'] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

/** Scope kosztu globalnego (budżet dobowy), rozłączny z UUID gospodarstwa. */
export const GLOBAL_SCOPE = 'global';

/**
 * Liczniki użycia asystenta: kwoty miesięczne per gospodarstwo i dobowy
 * budżet kosztu na całą instalację.
 *
 * Dlaczego licznik, a nie `count()` po `AiUsage`: kwotę trzeba zdjąć NA
 * STARCIE tury, jednym zapisem, który albo się uda, albo nie — inaczej dwa
 * telefony wchodzące równocześnie na ostatnią wiadomość miesiąca oba
 * przeczytają „199 < 200" i oba ruszą. `tryConsume` robi to warunkowym
 * `updateMany(value < limit)`: Postgres podnosi wartość dokładnie raz,
 * a `count === 0` znaczy „limit wyczerpany" bez żadnej blokady.
 *
 * Okresy liczone w UTC. Użytkownik w Warszawie dostaje odnowienie kwoty
 * o 1:00/2:00 w nocy — świadomy kompromis: doba serwera jest jedna, a
 * strefa klienta bywa różna nawet w jednym gospodarstwie.
 */
@Injectable()
export class AiUsageCountersService {
  constructor(private readonly prisma: PrismaService) {}

  /** `YYYY-MM` (UTC) — okres kwot miesięcznych. */
  monthKey(now: Date = new Date()): string {
    return now.toISOString().slice(0, 7);
  }

  /** `YYYY-MM-DD` (UTC) — okres budżetu dobowego. */
  dayKey(now: Date = new Date()): string {
    return now.toISOString().slice(0, 10);
  }

  /**
   * Zdejmuje 1 z kwoty, jeśli jest z czego. `false` = limit wyczerpany
   * (wołający oddaje 429 `AI_QUOTA_EXCEEDED`). Limit 0 nigdy nie przechodzi.
   */
  async tryConsume(
    client: UsageCounterClient,
    scopeId: string,
    periodKey: string,
    kind: UsageKind,
    limit: number,
  ): Promise<boolean> {
    if (limit <= 0) return false;
    // Wiersz musi istnieć, żeby `updateMany` miał co podnieść; `create` bez
    // `update` jest bezpieczne przy wyścigu (P2002 obsłuży ponowny odczyt
    // wołającego, a `upsert` z pustym `update` po prostu nic nie robi).
    await client.aiUsageCounter.upsert({
      where: { scopeId_periodKey_kind: { scopeId, periodKey, kind } },
      create: { scopeId, periodKey, kind, value: 0 },
      update: {},
    });
    const consumed = await client.aiUsageCounter.updateMany({
      where: { scopeId, periodKey, kind, value: { lt: limit } },
      data: { value: { increment: 1 } },
    });
    return consumed.count === 1;
  }

  /**
   * Dolicza `delta` (ujemna = zwrot kwoty po nieudanej turze). Zwrot nie
   * schodzi poniżej zera — przy równoległym resecie okresu licznik mógłby
   * inaczej wpaść na wartość ujemną i rozdać darmowe tury.
   */
  async add(
    client: UsageCounterClient,
    scopeId: string,
    periodKey: string,
    kind: UsageKind,
    delta: number,
  ): Promise<void> {
    if (delta === 0) return;
    await client.aiUsageCounter.upsert({
      where: { scopeId_periodKey_kind: { scopeId, periodKey, kind } },
      create: { scopeId, periodKey, kind, value: Math.max(0, delta) },
      update: { value: { increment: delta } },
    });
    if (delta < 0) {
      await client.aiUsageCounter.updateMany({
        where: { scopeId, periodKey, kind, value: { lt: 0 } },
        data: { value: 0 },
      });
    }
  }

  async read(
    scopeId: string,
    periodKey: string,
    kind: UsageKind,
    client: UsageCounterClient = this.prisma,
  ): Promise<number> {
    const row = await client.aiUsageCounter.findUnique({
      where: { scopeId_periodKey_kind: { scopeId, periodKey, kind } },
      select: { value: true },
    });
    return row?.value ?? 0;
  }
}
