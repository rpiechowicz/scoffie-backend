import { Injectable } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';

export type AgentTurnOutcome = 'done' | 'failed' | 'timeout' | 'limited';
export type AgentRejection =
  | 'disabled'
  | 'quota'
  | 'budget'
  | 'upstream'
  | 'inProgress'
  /** Wyczerpany miesięczny limit planów — odmowa NARZĘDZIA, nie całej tury. */
  | 'planQuota'
  /**
   * Zapis planu, który usunąłby za dużo pozycji bez potwierdzenia człowieka.
   * Osobny licznik, bo to jedyna odmowa, która mówi „model chciał skasować
   * cudzy tydzień" — jeśli zacznie rosnąć, prompt albo tryb są źle ustawione.
   */
  | 'destructive'
  /**
   * Model próbował ułożyć więcej niż tydzień w jednej turze albo tydzień
   * poza zasięgiem (`agent/tools/plan-scope.ts`).
   */
  | 'planRange';

/**
 * Liczniki asystenta od startu procesu — sekcja `agent` w `/ops/metrics`.
 *
 * Leżą w observability (nie w `src/agent/`), żeby `OpsController` nie
 * importował modułu asystenta: granica jest w jedną stronę — asystent woła
 * domenę i obserwowalność, nikt nie woła asystenta. Trwała księga użycia
 * (per użytkownik, per dzień) jest w bazie (`AiUsage`, `AiUsageCounter`); te
 * liczniki mówią tylko, co dzieje się TERAZ na tej instancji (jedna
 * instancja Railway — patrz analiza asystenta, „Jedna instancja").
 *
 * Te same zdarzenia idą jako metryki do Sentry (`scoffie.agent.*`) — tam
 * przeżywają restart i dają historię; bez `SENTRY_DSN` to no-op. Atrybuty
 * tylko o niskiej krotności: wynik, powód. Nigdy id użytkownika.
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
    planQuota: 0,
    destructive: 0,
    planRange: 0,
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
    Sentry.metrics.count('scoffie.agent.turn', 1, { attributes: { outcome } });
  }

  recordRejected(reason: AgentRejection): void {
    this.rejected[reason] += 1;
    Sentry.metrics.count('scoffie.agent.rejected', 1, {
      attributes: { reason },
    });
  }

  recordProviderUsage(
    usage: {
      inputTokens: number;
      outputTokens: number;
      costMicroUsd: number;
    },
    /** Ile żądań do dostawcy stoi za tym zużyciem (tura = 1 + rundy narzędzi). */
    calls = 1,
  ): void {
    this.usage.providerCalls += Math.max(1, calls);
    this.usage.inputTokens += usage.inputTokens;
    this.usage.outputTokens += usage.outputTokens;
    this.usage.costMicroUsd += usage.costMicroUsd;
    Sentry.metrics.count('scoffie.agent.provider_calls', Math.max(1, calls));
    Sentry.metrics.count('scoffie.agent.tokens', usage.inputTokens, {
      attributes: { direction: 'input' },
    });
    Sentry.metrics.count('scoffie.agent.tokens', usage.outputTokens, {
      attributes: { direction: 'output' },
    });
    Sentry.metrics.distribution(
      'scoffie.agent.cost_usd',
      usage.costMicroUsd / 1_000_000,
    );
  }

  recordUpstreamError(): void {
    this.upstreamErrors.total += 1;
    Sentry.metrics.count('scoffie.agent.upstream_error');
  }

  recordBreakerOpened(): void {
    this.upstreamErrors.breakerOpened += 1;
    Sentry.metrics.count('scoffie.agent.breaker_opened');
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
