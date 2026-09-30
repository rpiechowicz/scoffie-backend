import {
  BudgetedWriterModel,
  BudgetExceededError,
  BudgetGuard,
  worstCaseMicroUsd,
} from './writer.budget';
import type {
  WriterModel,
  WriterModelCall,
  WriterModelResult,
} from './writer.types';

const call: WriterModelCall = {
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  system: 'zasady',
  user: 'przepis',
  schema: { type: 'object' },
  maxTokens: 1000,
};

/** Model, który odpowiada dopiero na `release()` — do wyścigów. */
class SlowModel implements WriterModel {
  calls = 0;
  private waiting: Array<() => void> = [];
  constructor(private readonly cost: number) {}
  complete(): Promise<WriterModelResult> {
    this.calls += 1;
    return new Promise((resolve) =>
      this.waiting.push(() =>
        resolve({
          json: {},
          stopReason: 'end_turn',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costMicroUsd: this.cost,
            priceKnown: true,
          },
        }),
      ),
    );
  }
  release() {
    for (const done of this.waiting.splice(0)) done();
  }
}

describe('system pisania — budżet', () => {
  const worst = worstCaseMicroUsd(call);

  it('najgorszy koszt liczy bajty UTF-8, schemat, narzut i pełne max_tokens', () => {
    const longer = worstCaseMicroUsd({ ...call, user: 'przepis ąęść' });
    expect(longer).toBeGreaterThan(worst);
    // Sonnet 5.5: 10 $/MTok wyjścia → 1000 tokenów to co najmniej 10 000 µ$.
    expect(worst).toBeGreaterThan(10_000);
  });

  it('równoległe wywołania nie przekroczą limitu: drugie odpada, zanim pójdzie do API', async () => {
    const inner = new SlowModel(100);
    const guard = new BudgetGuard(worst + worst / 2);
    const model = new BudgetedWriterModel(inner, guard);
    const first = model.complete(call);
    await expect(model.complete(call)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(inner.calls).toBe(1);
    inner.release();
    await first;
    expect(guard.spentMicroUsd).toBe(100);
    // Po rozliczeniu rezerwacja wraca — kolejne wywołanie się mieści.
    const third = model.complete(call);
    inner.release();
    await third;
    expect(guard.spentMicroUsd).toBe(200);
  });

  it('błąd API liczy całą rezerwację (mogło kosztować)', async () => {
    const guard = new BudgetGuard(worst * 3);
    const model = new BudgetedWriterModel(
      { complete: () => Promise.reject(new Error('529 overloaded')) },
      guard,
    );
    await expect(model.complete(call)).rejects.toThrow('529');
    expect(guard.spentMicroUsd).toBe(worst);
  });
});
