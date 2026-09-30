import type Anthropic from '@anthropic-ai/sdk';
import {
  AnthropicBatchModel,
  batchCallId,
  BatchStoppedError,
  runBatchRounds,
  type BatchCall,
  type BatchCallResult,
  type BatchJournal,
  type BatchModel,
  type BatchRunResult,
  type InflightBatch,
} from './writer.batch';
import { BudgetGuard, worstCaseMicroUsd } from './writer.budget';
import { clone, kotletExample } from './writer.fixtures.spec-helper';
import {
  DEFAULT_WRITER_OPTIONS,
  ScenarioJob,
  writeCookScenario,
} from './writer.pipeline';
import { exampleOutput } from './writer.prompt';
import type {
  WriterModel,
  WriterModelCall,
  WriterModelResult,
  WriterRecipe,
} from './writer.types';

const example = kotletExample();
const kotlet = example.recipe;
const good = () => clone(exampleOutput(kotlet, example.content));
const review = (score: number) => ({
  score,
  issues: [],
  summary: `ocena ${score}`,
});
const badKey = () => {
  const out = good() as {
    scenario: { steps: Array<{ ingredients: Array<{ key: string }> }> };
  };
  out.scenario.steps[0].ingredients[0].key = 'i99';
  return out;
};
const result = (json: unknown): WriterModelResult => ({
  json,
  stopReason: 'end_turn',
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costMicroUsd: 1000,
    priceKnown: true,
  },
});
const recipeWithId = (id: string): WriterRecipe => ({ ...kotlet, id });
const idA = '11111111-1111-4111-8111-111111111111';
const idB = '22222222-2222-4222-8222-222222222222';
const key = (id: string) => id.replace(/-/g, '');
const noSleep = () => Promise.resolve();

/**
 * Paczki w pamięci z kolejką odpowiedzi PER PRZEPIS. `stopAfter` = ile
 * wywołań `run` przejdzie, zanim kolejne „zerwie komunikację” (paczka
 * przyjęta, wyniki nieodebrane) albo skończy się budżet — do testów
 * wznowienia.
 */
class FakeBatchModel implements BatchModel {
  readonly batches: BatchCall[][] = [];
  constructor(
    private readonly replies: Map<string, unknown[]>,
    private stopAfter = Infinity,
    private readonly stopReason: 'transport' | 'budget' = 'transport',
  ) {}

  private answer(calls: BatchCall[]) {
    const out = new Map<string, BatchCallResult>();
    for (const { id } of calls) {
      const queue = this.replies.get(id.split('-r')[0]) ?? [];
      out.set(id, { ok: true, result: result(queue.shift()) });
    }
    return out;
  }

  async run(
    calls: BatchCall[],
    onSubmitted?: (batch: InflightBatch) => Promise<void>,
  ): Promise<BatchRunResult> {
    if (this.stopAfter <= 0 && this.stopReason === 'budget') {
      return { results: new Map(), interrupted: [], stopReason: 'budget' };
    }
    this.batches.push(calls);
    const inflight = {
      batchId: `b${this.batches.length}`,
      ids: calls.map((c) => c.id),
      reservedMicroUsd: 100,
    };
    await onSubmitted?.(inflight);
    if (this.stopAfter <= 0) {
      return {
        results: new Map(),
        interrupted: [inflight],
        stopReason: 'transport',
      };
    }
    this.stopAfter -= 1;
    return { results: this.answer(calls), interrupted: [], stopReason: null };
  }

  collect(batch: InflightBatch, calls: BatchCall[]): Promise<BatchRunResult> {
    expect(calls.map((c) => c.id)).toEqual(batch.ids);
    this.stopAfter = Infinity;
    return Promise.resolve({
      results: this.answer(calls),
      interrupted: [],
      stopReason: null,
    });
  }
}

const replies = () =>
  new Map([
    [key(idA), [good(), review(5)]],
    [key(idB), [badKey(), good(), review(4)]],
  ]);
const newJobs = () => [
  new ScenarioJob(recipeWithId(idA), example),
  new ScenarioJob(recipeWithId(idB), example),
];
const live = (answers: unknown[]): WriterModel => {
  const queue = clone(answers);
  return { complete: () => Promise.resolve(result(queue.shift())) };
};

describe('system pisania — rundy paczek', () => {
  it('prowadzą zadania do końca i dają TEN SAM wynik co wywołania na żywo', async () => {
    const model = new FakeBatchModel(replies());
    const jobs = newJobs();
    const saved: string[] = [];
    await runBatchRounds(jobs, model, {
      onDone: (job) => {
        saved.push(job.recipe.id);
        return Promise.resolve();
      },
    });
    // Runda 1: dwóch autorów; 2: recenzent A + poprawka B; 3: recenzent B.
    expect(model.batches.map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(model.batches[0].map((c) => c.id)).toEqual([
      batchCallId(idA, 1),
      batchCallId(idB, 1),
    ]);
    expect(saved).toEqual([idA, idB]);
    expect(jobs[0].outcome()).toEqual(
      await writeCookScenario(
        live([good(), review(5)]),
        recipeWithId(idA),
        example,
      ),
    );
    expect(jobs[1].outcome()).toEqual(
      await writeCookScenario(
        live([badKey(), good(), review(4)]),
        recipeWithId(idB),
        example,
      ),
    );
  });

  it('błąd pozycji przerywa tylko to zadanie (bez wyniku, do ponowienia)', async () => {
    const model: BatchModel = {
      run: (calls) =>
        Promise.resolve({
          results: new Map(
            calls.map((c): [string, BatchCallResult] => [
              c.id,
              c.id.startsWith(key(idA))
                ? { ok: false, error: 'błąd API: overloaded' }
                : { ok: true, result: result(good()) },
            ]),
          ),
          interrupted: [],
          stopReason: null,
        }),
      collect: () => Promise.reject(new Error('nieużywane')),
    };
    const jobs = [
      new ScenarioJob(recipeWithId(idA), example),
      new ScenarioJob(recipeWithId(idB), example, {
        ...DEFAULT_WRITER_OPTIONS,
        maxAttempts: 1,
      }),
    ];
    const done: ScenarioJob[] = [];
    await runBatchRounds(jobs, model, {
      onDone: (job) => {
        done.push(job);
        return Promise.resolve();
      },
    });
    expect(jobs[0].failure).toBe('błąd API: overloaded');
    expect(done).toHaveLength(2);
  });

  it('padający zapis jednego przepisu nie gubi pozostałych; trwały błąd zapisu = stop do wznowienia', async () => {
    const model = new FakeBatchModel(replies());
    const jobs = newJobs();
    const tries = new Map<string, number>();
    let journal: BatchJournal | null = null;
    let databaseUp = false;
    const onDone = (job: ScenarioJob) => {
      const n = (tries.get(job.recipe.id) ?? 0) + 1;
      tries.set(job.recipe.id, n);
      if (job.recipe.id === idA && !databaseUp) {
        return Promise.reject(new Error('baza leży'));
      }
      if (job.recipe.id === idB && n === 1) {
        return Promise.reject(new Error('chwilowo'));
      }
      return Promise.resolve();
    };
    const persist = (j: BatchJournal) => {
      journal = clone(j);
      return Promise.resolve();
    };
    await expect(
      runBatchRounds(jobs, model, { onDone, persist, sleep: noSleep }),
    ).rejects.toMatchObject({ reason: 'save' });
    // B zapisany (2. próba), A nie — ale jego wynik czeka w dzienniku.
    expect(tries.get(idB)).toBe(2);
    expect(journal!.handled).toEqual([jobs[1].jobId]);
    expect(journal!.jobs[0].result?.status).toBe('VALIDATED');

    // Baza wróciła: wznowienie zapisuje A bez żadnego wywołania modelu.
    databaseUp = true;
    const restored = journal!.jobs.map((s) => ScenarioJob.restore(s, example));
    const idle: BatchModel = {
      run: () => Promise.reject(new Error('nie powinno wołać modelu')),
      collect: () => Promise.reject(new Error('nie powinno wołać modelu')),
    };
    await runBatchRounds(restored, idle, {
      onDone,
      persist,
      resume: journal!,
      sleep: noSleep,
    });
    expect(journal!.handled.sort()).toEqual(
      [jobs[0].jobId, jobs[1].jobId].sort(),
    );
  });

  it('zerwana komunikacja zatrzymuje przebieg; wznowienie odbiera opłaconą paczkę i kończy tak samo', async () => {
    const journals: BatchJournal[] = [];
    const persist = (j: BatchJournal) => {
      journals.push(clone(j));
      return Promise.resolve();
    };
    // Runda 1 przechodzi, w rundzie 2 paczka przyjęta, ale nieodebrana.
    const model = new FakeBatchModel(replies(), 1);
    const jobs = newJobs();
    await expect(
      runBatchRounds(jobs, model, { onDone: () => Promise.resolve(), persist }),
    ).rejects.toBeInstanceOf(BatchStoppedError);
    const stopped = journals[journals.length - 1];
    expect(stopped.round).toBe(2);
    expect(stopped.inflight.map((b) => b.batchId)).toEqual(['b2']);

    // Nowy proces: zadania z dziennika, najpierw odbiór paczki b2.
    const restored = stopped.jobs.map((state) =>
      ScenarioJob.restore(state, example),
    );
    const saved: string[] = [];
    await runBatchRounds(restored, model, {
      onDone: (job) => {
        saved.push(job.recipe.id);
        return Promise.resolve();
      },
      persist,
      resume: stopped,
    });
    expect(saved).toEqual([idA, idB]);
    // Bez przerwy wyszłoby to samo.
    const reference = newJobs();
    await runBatchRounds(reference, new FakeBatchModel(replies()), {
      onDone: () => Promise.resolve(),
    });
    expect(restored.map((j) => j.outcome())).toEqual(
      reference.map((j) => j.outcome()),
    );
    // Paczka b2 nie poszła drugi raz: wysłane b1, b2, b3.
    expect(model.batches).toHaveLength(3);
  });

  it('brak budżetu zatrzymuje przebieg bez porzucania zadań — po doładowaniu jadą dalej', async () => {
    let journal: BatchJournal | null = null;
    const shared = replies();
    const model = new FakeBatchModel(shared, 1, 'budget');
    const jobs = newJobs();
    await expect(
      runBatchRounds(jobs, model, {
        onDone: () => Promise.resolve(),
        persist: (j) => {
          journal = clone(j);
          return Promise.resolve();
        },
      }),
    ).rejects.toMatchObject({ reason: 'budget' });
    expect(jobs.every((j) => !j.done && !j.failure)).toBe(true);
    const restored = journal!.jobs.map((s) => ScenarioJob.restore(s, example));
    await runBatchRounds(restored, new FakeBatchModel(shared), {
      onDone: () => Promise.resolve(),
      resume: journal!,
    });
    expect(restored.map((j) => j.outcome().status)).toEqual([
      'VALIDATED',
      'VALIDATED',
    ]);
  });
});

describe('Anthropic Message Batches — budżet, ponowienia, odbiór', () => {
  const call: WriterModelCall = {
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    system: 'zasady',
    user: 'przepis',
    schema: { type: 'object' },
    maxTokens: 1000,
  };
  const worst = worstCaseMicroUsd(call, 0.5);
  // Sonnet 5.5: (1000 × 2 + 100 × 10) µ$ × 0,5 (paczka) = 1500 µ$ za pozycję.
  const ACTUAL = 1500;
  const message = () =>
    ({
      content: [{ type: 'text', text: '{"a":1}' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 1000,
        output_tokens: 100,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }) as unknown as Anthropic.Message;

  /** Klient z paczkami; `faults` steruje awariami poszczególnych metod. */
  const fakeClient = (
    created: string[][],
    faults: { create?: boolean; retrieve?: number; results?: number } = {},
  ) => {
    let retrieveFails = faults.retrieve ?? 0;
    let resultsFails = faults.results ?? 0;
    return {
      messages: {
        batches: {
          create: (body: { requests: { custom_id: string }[] }) => {
            if (faults.create) return Promise.reject(new Error('400 invalid'));
            created.push(body.requests.map((r) => r.custom_id));
            return Promise.resolve({ id: `b${created.length}` });
          },
          retrieve: () => {
            if (retrieveFails > 0) {
              retrieveFails -= 1;
              return Promise.reject(new Error('ECONNRESET'));
            }
            return Promise.resolve({
              processing_status: 'ended',
              request_counts: {
                succeeded: 0,
                errored: 0,
                expired: 0,
                canceled: 0,
              },
            });
          },
          results: (batchId: string) => {
            if (resultsFails > 0) {
              resultsFails -= 1;
              return Promise.reject(new Error('502'));
            }
            const ids = created[Number(batchId.slice(1)) - 1];
            return Promise.resolve(
              (async function* () {
                for (const id of ids) {
                  await Promise.resolve();
                  yield id.includes('bad')
                    ? {
                        custom_id: id,
                        result: {
                          type: 'errored',
                          error: { type: 'overloaded' },
                        },
                      }
                    : {
                        custom_id: id,
                        result: { type: 'succeeded', message: message() },
                      };
                }
              })(),
            );
          },
        },
      },
    } as unknown as Anthropic;
  };
  const model = (client: Anthropic, guard: BudgetGuard, retries = 3) =>
    new AnthropicBatchModel(client, guard, undefined, {
      sleep: noSleep,
      retries,
    });

  it('paczka bierze tyle pozycji, ile mieści budżet; reszta idzie następną paczką', async () => {
    const created: string[][] = [];
    const guard = new BudgetGuard(worst + worst / 2);
    const outcome = await model(fakeClient(created), guard).run([
      { id: 'a-r1', call },
      { id: 'b-r1', call },
    ]);
    expect(created).toEqual([['a-r1'], ['b-r1']]);
    expect(outcome.stopReason).toBeNull();
    expect(guard.spentMicroUsd).toBe(2 * ACTUAL);
  });

  it('błędna pozycja nic nie kosztuje; brak budżetu nawet na jedną = stop „budget”', async () => {
    const created: string[][] = [];
    const guard = new BudgetGuard(worst * 3);
    const outcome = await model(fakeClient(created), guard).run([
      { id: 'a-r1', call },
      { id: 'x-bad-r1', call },
    ]);
    expect(outcome.results.get('x-bad-r1')).toMatchObject({ ok: false });
    expect(guard.spentMicroUsd).toBe(ACTUAL);

    const poor = await model(fakeClient([]), new BudgetGuard(worst - 1)).run([
      { id: 'a-r1', call },
    ]);
    expect(poor).toMatchObject({ stopReason: 'budget', interrupted: [] });
    expect(poor.results.size).toBe(0);
  });

  it('paczka nieprzyjęta: stop „transport”, zero kosztu, zadania nietknięte', async () => {
    const guard = new BudgetGuard(worst * 3);
    const outcome = await model(fakeClient([], { create: true }), guard).run([
      { id: 'a-r1', call },
    ]);
    expect(outcome).toMatchObject({ stopReason: 'transport', interrupted: [] });
    expect(outcome.results.size).toBe(0);
    expect(guard.spentMicroUsd).toBe(0);
  });

  it('chwilowy błąd odpytywania jest ponawiany i paczka zostaje odebrana', async () => {
    const created: string[][] = [];
    const guard = new BudgetGuard(worst * 3);
    const outcome = await model(
      fakeClient(created, { retrieve: 2, results: 1 }),
      guard,
    ).run([{ id: 'a-r1', call }]);
    expect(outcome.stopReason).toBeNull();
    expect(outcome.results.get('a-r1')).toMatchObject({ ok: true });
    expect(guard.spentMicroUsd).toBe(ACTUAL);
  });

  it('nieodebrana paczka idzie do dziennika; odbiór po wznowieniu rozlicza ją dokładnie raz', async () => {
    const created: string[][] = [];
    const guard = new BudgetGuard(worst * 3);
    const submitted: InflightBatch[] = [];
    const outcome = await model(
      fakeClient(created, { results: 10 }),
      guard,
      2,
    ).run([{ id: 'a-r1', call }], (b) => {
      submitted.push(b);
      return Promise.resolve();
    });
    expect(outcome.stopReason).toBe('transport');
    expect(outcome.interrupted).toEqual(submitted);
    // W tym procesie rezerwacja liczy się jako wydana (ostrożnie).
    expect(guard.spentMicroUsd).toBe(outcome.interrupted[0].reservedMicroUsd);

    // Nowy proces: wydane bez rezerwacji paczek w locie, potem odbiór.
    const resumed = new BudgetGuard(
      worst * 3,
      guard.spentMicroUsd - outcome.interrupted[0].reservedMicroUsd,
    );
    const collected = await model(fakeClient(created), resumed).collect(
      outcome.interrupted[0],
      [{ id: 'a-r1', call }],
    );
    expect(collected.results.get('a-r1')).toMatchObject({ ok: true });
    expect(resumed.spentMicroUsd).toBe(ACTUAL);
  });
});
