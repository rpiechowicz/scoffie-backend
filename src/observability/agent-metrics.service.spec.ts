import { AgentMetricsService } from './agent-metrics.service';

describe('AgentMetricsService', () => {
  it('zaczyna od zer i liczy tury, odmowy, użycie', () => {
    const metrics = new AgentMetricsService();
    expect(metrics.snapshot()).toEqual({
      turns: { started: 0, done: 0, failed: 0, timeout: 0, limited: 0 },
      jobs: {
        ready: 0,
        claimed: 0,
        running: 0,
        attempts: 0,
        recovered: 0,
        leaseLost: 0,
        failed: 0,
        cancelled: 0,
        effectConflicts: 0,
      },
      rejected: {
        disabled: 0,
        quota: 0,
        budget: 0,
        upstream: 0,
        inProgress: 0,
        planQuota: 0,
        destructive: 0,
        planRange: 0,
      },
      usage: {
        providerCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        costMicroUsd: 0,
      },
      upstream: { total: 0, breakerOpened: 0 },
      planner: {
        build_meal_plan: { OK: 0, PARTIAL: 0, UNSAT: 0 },
        replace_plan_item: { OK: 0, PARTIAL: 0, UNSAT: 0 },
        suggest_meals: { OK: 0, PARTIAL: 0, UNSAT: 0 },
      },
      showOthers: { used: 0, exhausted: 0 },
      proposalRefErrors: { revise_proposal: 0, replace_plan_item: 0 },
    });

    metrics.recordTurnStarted();
    metrics.recordTurnStarted();
    metrics.recordTurnFinished('done');
    metrics.recordTurnFinished('timeout');
    metrics.recordRejected('quota');
    metrics.recordRejected('disabled');
    metrics.recordRejected('planQuota');
    metrics.recordProviderUsage({
      inputTokens: 1200,
      outputTokens: 300,
      costMicroUsd: 8100,
    });
    metrics.recordProviderUsage({
      inputTokens: 100,
      outputTokens: 50,
      costMicroUsd: 900,
    });
    metrics.recordUpstreamError();
    metrics.recordBreakerOpened();

    expect(metrics.snapshot()).toEqual({
      turns: { started: 2, done: 1, failed: 0, timeout: 1, limited: 0 },
      jobs: {
        ready: 0,
        claimed: 0,
        running: 0,
        attempts: 0,
        recovered: 0,
        leaseLost: 0,
        failed: 0,
        cancelled: 0,
        effectConflicts: 0,
      },
      rejected: {
        disabled: 1,
        quota: 1,
        budget: 0,
        upstream: 0,
        inProgress: 0,
        planQuota: 1,
        destructive: 0,
        planRange: 0,
      },
      usage: {
        providerCalls: 2,
        inputTokens: 1300,
        outputTokens: 350,
        costMicroUsd: 9000,
      },
      upstream: { total: 1, breakerOpened: 1 },
      planner: {
        build_meal_plan: { OK: 0, PARTIAL: 0, UNSAT: 0 },
        replace_plan_item: { OK: 0, PARTIAL: 0, UNSAT: 0 },
        suggest_meals: { OK: 0, PARTIAL: 0, UNSAT: 0 },
      },
      showOthers: { used: 0, exhausted: 0 },
      proposalRefErrors: { revise_proposal: 0, replace_plan_item: 0 },
    });
  });

  it('liczy wyniki planera, „pokaż inne” i błędy odwołań do propozycji (N8C §9)', () => {
    const metrics = new AgentMetricsService();
    metrics.recordPlannerOutcome('build_meal_plan', 'PARTIAL');
    metrics.recordPlannerOutcome('build_meal_plan', 'PARTIAL');
    metrics.recordPlannerOutcome('suggest_meals', 'UNSAT');
    metrics.recordShowOthers(false);
    metrics.recordShowOthers(true);
    metrics.recordProposalRefError('revise_proposal');
    const snapshot = metrics.snapshot();
    expect(snapshot.planner.build_meal_plan).toEqual({
      OK: 0,
      PARTIAL: 2,
      UNSAT: 0,
    });
    expect(snapshot.planner.suggest_meals.UNSAT).toBe(1);
    expect(snapshot.showOthers).toEqual({ used: 2, exhausted: 1 });
    expect(snapshot.proposalRefErrors).toEqual({
      revise_proposal: 1,
      replace_plan_item: 0,
    });
    // Kopie, nie wewnętrzne obiekty — także zagnieżdżone.
    snapshot.planner.build_meal_plan.PARTIAL = 99;
    expect(metrics.snapshot().planner.build_meal_plan.PARTIAL).toBe(2);
  });

  it('snapshot oddaje kopie, nie wewnętrzne obiekty', () => {
    const metrics = new AgentMetricsService();
    const first = metrics.snapshot();
    first.turns.started = 99;
    expect(metrics.snapshot().turns.started).toBe(0);
  });
});
