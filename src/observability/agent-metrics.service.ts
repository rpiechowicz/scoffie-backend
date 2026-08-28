import { Injectable } from '@nestjs/common';

export type AgentTurnOutcome = 'done' | 'failed' | 'timeout' | 'limited';
export type AgentRejection =
  | 'disabled'
  | 'quota'
  | 'budget'
  | 'upstream'
  | 'inProgress';

/**
 * Liczniki asystenta od startu procesu — sekcja `agent` w `/ops/metrics`.
 *
 * Leżą w observability (nie w `src/agent/`), żeby `OpsController` nie
 * importował modułu asystenta: granica jest w jedną stronę — asystent woła
 * domenę i obserwowalność, nikt nie woła asystenta. Trwała księga użycia
 * (per użytkownik, per dzień) jest w bazie (`AiUsage`, `AiUsageCounter`); te
 * liczniki mówią tylko, co dzieje się TERAZ na tej instancji (jedna
 * instancja Railway — patrz analiza asystenta, „Jedna instancja").
 */
@Injectable()
export class AgentMetricsService {
  private readonly turns = {
    started: 0,
    done: 0,
    failed: 0,
    timeout: 0,
    limited: 0,
  };
  private readonly rejected: Record<AgentRejection, number> = {
    disabled: 0,
    quota: 0,
    budget: 0,
    upstream: 0,
    inProgress: 0,
  };
  private readonly usage = {
    providerCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costMicroUsd: 0,
  };
  private readonly upstreamErrors = { total: 0, breakerOpened: 0 };

  recordTurnStarted(): void {
    this.turns.started += 1;
  }

  recordTurnFinished(outcome: AgentTurnOutcome): void {
    this.turns[outcome] += 1;
  }

  recordRejected(reason: AgentRejection): void {
    this.rejected[reason] += 1;
  }

  recordProviderUsage(usage: {
    inputTokens: number;
    outputTokens: number;
    costMicroUsd: number;
  }): void {
    this.usage.providerCalls += 1;
    this.usage.inputTokens += usage.inputTokens;
    this.usage.outputTokens += usage.outputTokens;
    this.usage.costMicroUsd += usage.costMicroUsd;
  }

  recordUpstreamError(): void {
    this.upstreamErrors.total += 1;
  }

  recordBreakerOpened(): void {
    this.upstreamErrors.breakerOpened += 1;
  }

  snapshot() {
    return {
      turns: { ...this.turns },
      rejected: { ...this.rejected },
      usage: { ...this.usage },
      upstream: { ...this.upstreamErrors },
    };
  }
}
