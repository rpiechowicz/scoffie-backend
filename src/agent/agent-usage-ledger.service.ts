import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AgentEnv } from '../config/agent-env';
import { PrismaService } from '../prisma/prisma.service';
import {
  AiUsageCountersService,
  GLOBAL_SCOPE,
  UsageCounterClient,
} from './ai-usage-counters.service';
import {
  AgentProviderCall,
  AgentUsageVerdict,
} from './providers/agent-provider';

/**
 * Klucz idempotencji wywołania w księdze: ten sam dla każdego zapisu tego
 * samego wywołania, niezależnie od tego, czy tura jeszcze istnieje. Ten sam
 * kształt nadaje istniejącym wierszom migracja `ksiega_klucz_wywolania`.
 *
 * Od Etapu 5 tura może mieć kilka PRÓB wykonania (odzyskanie po padzie
 * procesu), a każda liczy `callIndex` od zera. Druga próba to NOWE, realne
 * wywołania dostawcy — z kluczem pierwszej księga uznałaby je za powtórkę
 * i zgubiła koszt. Dlatego od próby 2 klucz niesie jej numer:
 * `turn:<turnId>:a<próba>:<callIndex>`. Próba 1 zostaje w starym kształcie —
 * istniejące wiersze i raporty bez zmian. Ponowiony zapis TEGO SAMEGO
 * wywołania (ta sama próba, ten sam indeks) trafia w ten sam klucz.
 */
export function usageCallKey(
  turnId: string,
  callIndex: number,
  attempt = 1,
): string {
  return attempt <= 1
    ? `turn:${turnId}:${callIndex}`
    : `turn:${turnId}:a${attempt}:${callIndex}`;
}

/** Tożsamość tury, pod którą księga zapisuje wywołania. */
export type LedgerTurn = {
  turnId: string;
  userId: string;
  householdId: string;
  provider: string;
  /** Próba wykonania tury (Etap 5); brak = 1. */
  attempt?: number;
  /** Konfiguracja z przyjęcia tury — sufity kosztu do werdyktu budżetu. */
  env: Pick<
    AgentEnv,
    'householdDailyCostUsd' | 'householdMonthlyCostUsd' | 'globalDailyBudgetUsd'
  >;
};

/**
 * Księga kosztu asystenta: JEDEN wiersz `AiUsage` na wywołanie dostawcy,
 * zapisany zaraz po nim (workstream assistant-backend-optimization, Etap 1).
 *
 * DLACZEGO NIE PRZY DOMKNIĘCIU TURY, jak do 26.09.2026. Koszt, liczniki
 * sufitów i tokeny tury pisało `finishDone`/`finishFailed`, ale tylko wtedy,
 * gdy to runner domknął turę. Tura domknięta z zewnątrz — leniwy timeout
 * z odczytu, „Stop" spoza procesu, sprzątanie po restarcie — gubiła wszystko,
 * co dostawca już naliczył, a do tego oddawała wiadomość, bo „tura nic nie
 * kosztowała". Teraz pieniądze trafiają do bazy w chwili, w której zostały
 * wydane, niezależnie od tego, kto i jak turę zamknie.
 *
 * Jedna transakcja na wywołanie: wiersz księgi, tokeny i koszt tury
 * (przyrost, bez względu na status), liczniki kosztu domu (doba, miesiąc)
 * i instalacji (doba). Kluczem idempotencji jest `callKey`
 * (`turn:<turnId>:<callIndex>`, patrz `usageCallKey`) — nie-null i niezależny
 * od FK do tury, więc działa także po jej usunięciu. `skipDuplicates` przy
 * ponowieniu oddaje `count = 0` i nic więcej się nie dolicza.
 *
 * Tura już zamknięta ze zwrotem kwoty (`quotaRefunded`), do której dojechał
 * koszt, traci zwrot: flaga wraca na `false`, a wiadomość do licznika. To ta
 * sama reguła co w runnerze — zwrot należy się wyłącznie za darmową turę —
 * tylko dopięta z drugiej strony wyścigu.
 */
@Injectable()
export class AgentUsageLedger {
  constructor(
    private readonly prisma: PrismaService,
    private readonly counters: AiUsageCountersService,
  ) {}

  async record(
    turn: LedgerTurn,
    call: AgentProviderCall,
  ): Promise<AgentUsageVerdict> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.agentTurn.findUnique({
        where: { id: turn.turnId },
        select: { quotaScopeId: true, quotaPeriodKey: true, startedAt: true },
      });
      // Tura zniknęła w trakcie (rozmowa skasowana, RODO): wiersz zostaje bez
      // tury, bo pieniądze i tak poszły — raporty liczą takie wiersze do
      // kosztu, a sufity muszą je widzieć.
      const inserted = await tx.aiUsage.createMany({
        data: [
          {
            // Klucz z identyfikatora tury, NIE z istnienia wiersza tury:
            // ponowienie po skasowaniu rozmowy trafia w ten sam klucz.
            callKey: usageCallKey(turn.turnId, call.callIndex, turn.attempt),
            turnId: current ? turn.turnId : null,
            callIndex: call.callIndex,
            attempt: turn.attempt ?? 1,
            userId: turn.userId,
            householdId: turn.householdId,
            provider: turn.provider,
            model: call.model,
            effort: call.effort,
            inputTokens: call.usage.inputTokens,
            cacheReadTokens: call.usage.cacheReadTokens,
            cacheWriteTokens: call.usage.cacheWriteTokens,
            outputTokens: call.usage.outputTokens,
            costMicroUsd: call.usage.costMicroUsd,
            apiCalls: call.apiCalls === undefined ? 1 : call.apiCalls,
            stopReason: call.stopReason,
            latencyMs: call.latencyMs,
          },
        ],
        skipDuplicates: true,
      });
      // To wywołanie jest już w księdze (ponowienie) — liczniki też.
      if (inserted.count === 0) return { budgetExceeded: false };

      const cost = call.usage.costMicroUsd;
      if (current) {
        // Przyrost, nie nadpisanie: tura sumuje swoje wywołania także po
        // domknięciu, więc `GET /agent/turns/:id` i panel widzą pełny koszt.
        await tx.agentTurn.updateMany({
          where: { id: turn.turnId },
          data: {
            inputTokens: { increment: call.usage.inputTokens },
            outputTokens: { increment: call.usage.outputTokens },
            costMicroUsd: { increment: cost },
          },
        });
        if (cost > 0) {
          const recharged = await tx.agentTurn.updateMany({
            where: { id: turn.turnId, quotaRefunded: true },
            data: { quotaRefunded: false },
          });
          if (recharged.count > 0) {
            await this.counters.add(
              tx,
              current.quotaScopeId ?? turn.householdId,
              current.quotaPeriodKey ??
                this.counters.monthKey(current.startedAt),
              'messages',
              1,
            );
          }
        }
      }
      await this.counters.addHouseholdCost(tx, turn.householdId, cost);
      await this.counters.add(
        tx,
        GLOBAL_SCOPE,
        this.counters.dayKey(),
        'costMicroUsd',
        cost,
      );
      return { budgetExceeded: await this.overBudget(tx, turn) };
    });
  }

  /**
   * Zwrot wiadomości za turę, która NIC nie kosztowała — jedna reguła dla
   * wszystkich ścieżek domknięcia (runner, leniwy timeout, „Stop" spoza
   * procesu, sprzątanie osieroconych tur, lease przy nowej wiadomości).
   *
   * Warunek siedzi w samym `updateMany` (`costMicroUsd: 0`,
   * `quotaRefunded: false`), a nie w pamięci wołającego: koszt dopisuje
   * księga z innej transakcji i tylko baza wie, ile tura naprawdę wydała.
   * Wyścig z `record` rozstrzyga blokada wiersza tury — kto pierwszy, ten
   * wygrywa, a drugi widzi już jego zapis. Wołać PO zamknięciu tury i w tej
   * samej transakcji, w której zamyka się ją razem z licznikiem.
   *
   * `true` = zwrot wykonany (flaga + licznik).
   */
  async refundIfFree(
    tx: Prisma.TransactionClient,
    turnId: string,
    fallbackScopeId: string,
  ): Promise<boolean> {
    const flipped = await tx.agentTurn.updateMany({
      where: { id: turnId, quotaRefunded: false, costMicroUsd: 0 },
      data: { quotaRefunded: true },
    });
    if (flipped.count === 0) return false;
    const turn = await tx.agentTurn.findUnique({
      where: { id: turnId },
      select: { quotaScopeId: true, quotaPeriodKey: true, startedAt: true },
    });
    if (!turn) return false;
    // Kwota wraca TAM, skąd zeszła: zakres i okres z chwili pobrania, nie
    // z chwili zwrotu (tura zaczęta 31. o 23:59 oddaje do starego okresu).
    await this.counters.add(
      tx,
      turn.quotaScopeId ?? fallbackScopeId,
      turn.quotaPeriodKey ?? this.counters.monthKey(turn.startedAt),
      'messages',
      -1,
    );
    return true;
  }

  /**
   * Domknięcie tury Z ZEWNĄTRZ — nie przez runnera, który ją prowadził
   * (leniwy timeout z odczytu, „Stop" spoza procesu, lease przy nowej
   * wiadomości, sprzątanie osieroconych tur). Warunkowo po `RUNNING`, bez
   * dotykania kosztu (ten zna tylko księga), potem zwrot za darmową turę —
   * w tej samej transakcji. `true` = to my zamknęliśmy turę.
   */
  async closeTurn(
    tx: Prisma.TransactionClient,
    params: {
      turnId: string;
      errorCode: 'AI_TIMEOUT' | 'AI_CANCELLED' | 'AI_PROVIDER_ERROR';
      fallbackScopeId: string;
      /** Dokładny powód dla operatora (`AgentTurn.failureDetail`, Etap 5). */
      failureDetail?: string;
      /**
       * Tylko gdy żaden worker nie trzyma żywego lease (Etap 5) — „Stop"
       * tury prowadzonej gdzie indziej zostaje trwałym żądaniem, które
       * worker odczyta przy najbliższym odnowieniu.
       */
      onlyIfUnleased?: boolean;
    },
  ): Promise<boolean> {
    const closed = await tx.agentTurn.updateMany({
      where: {
        id: params.turnId,
        status: 'RUNNING',
        ...(params.onlyIfUnleased
          ? {
              OR: [
                { leaseExpiresAt: null },
                { leaseExpiresAt: { lte: new Date() } },
              ],
            }
          : {}),
      },
      data: {
        status: 'FAILED',
        errorCode: params.errorCode,
        finishedAt: new Date(),
        leaseExpiresAt: null,
        ...(params.failureDetail
          ? { failureDetail: params.failureDetail }
          : {}),
      },
    });
    if (closed.count === 0) return false;
    await this.refundIfFree(tx, params.turnId, params.fallbackScopeId);
    return true;
  }

  /** Czy po tym wywołaniu któryś sufit kosztu jest już osiągnięty. */
  private async overBudget(
    client: UsageCounterClient,
    turn: LedgerTurn,
  ): Promise<boolean> {
    const ceilings: Array<[string, string, number | null]> = [
      [
        turn.householdId,
        this.counters.dayKey(),
        turn.env.householdDailyCostUsd,
      ],
      [
        turn.householdId,
        this.counters.monthKey(),
        turn.env.householdMonthlyCostUsd,
      ],
      [GLOBAL_SCOPE, this.counters.dayKey(), turn.env.globalDailyBudgetUsd],
    ];
    for (const [scopeId, periodKey, limitUsd] of ceilings) {
      if (limitUsd === null) continue;
      const spent = await this.counters.read(
        scopeId,
        periodKey,
        'costMicroUsd',
        client,
      );
      if (spent >= limitUsd * 1_000_000) return true;
    }
    return false;
  }
}
