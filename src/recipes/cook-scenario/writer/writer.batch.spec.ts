import type Anthropic from '@anthropic-ai/sdk';
import {
  AnthropicBatchModel,
  batchCallId,
  runBatchRounds,
  type BatchCall,
  type BatchCallResult,
  type BatchModel,
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

/** Paczki z kolejką odpowiedzi PER PRZEPIS — jak Batch API, tylko w pamięci. */
class FakeBatchModel implements BatchModel {
  readonly batches: BatchCall[][] = [];
  constructor(private readonly replies: Map<string, unknown[]>) {}
  run(calls: BatchCall[]): Promise<Map<string, BatchCallResult>> {
    this.batches.push(calls);
    const out = new Map<string, BatchCallResult>();
    for (const { id } of calls) {
      const recipe = id.split('-r')[0];
      const queue = this.replies.get(recipe) ?? [];
      out.set(id, { ok: true, result: result(queue.shift()) });
    }
    return Promise.resolve(out);
  }
}

describe('system pisania — Batch API', () => {
  const idA = '11111111-1111-4111-8111-111111111111';
  const idB = '22222222-2222-4222-8222-222222222222';

  it('rundy prowadzą zadania do końca i dają TEN SAM wynik co wywołania na żywo', async () => {
    const repliesA = [good(), review(5)];
    const repliesB = [badKey(), good(), review(4)];
    const model = new FakeBatchModel(
      new Map([
        [idA.replace(/-/g, ''), clone(repliesA)],
        [idB.replace(/-/g, ''), clone(repliesB)],
      ]),
    );
    const jobs = [
      new ScenarioJob(recipeWithId(idA), example),
      new ScenarioJob(recipeWithId(idB), example),
    ];
    const done: string[] = [];
    await runBatchRounds(jobs, model, (job) => {
      done.push(job.recipe.id);
      return Promise.resolve();
    });

    // Runda 1: dwóch autorów; 2: recenzent A + poprawka B; 3: recenzent B.
    expect(model.batches.map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(model.batches[0].map((c) => c.id)).toEqual([
      batchCallId(idA, 1),
      batchCallId(idB, 1),
    ]);
    expect(done).toEqual([idA, idB]);

    // Ten sam przepis, te same odpowiedzi, na żywo — identyczny wynik.
    const live = (replies: unknown[]): WriterModel => {
      const queue = clone(replies);
      return { complete: () => Promise.resolve(result(queue.shift())) };
    };
    expect(jobs[0].outcome()).toEqual(
      await writeCookScenario(live(repliesA), recipeWithId(idA), example),
    );
    expect(jobs[1].outcome()).toEqual(
      await writeCookScenario(live(repliesB), recipeWithId(idB), example),
    );
    expect(jobs[1].outcome().status).toBe('VALIDATED');
    expect(jobs[1].outcome().attempts).toHaveLength(2);
  });

  it('błąd pozycji przerywa tylko to zadanie (bez wyniku, do ponowienia)', async () => {
    const model: BatchModel = {
      run: (calls) =>
        Promise.resolve(
          new Map(
            calls.map((c): [string, BatchCallResult] => [
              c.id,
              c.id.startsWith(idA.replace(/-/g, ''))
                ? { ok: false, error: 'błąd API: overloaded' }
                : { ok: true, result: result(good()) },
            ]),
          ),
        ),
    };
    const jobs = [
      new ScenarioJob(recipeWithId(idA), example),
      new ScenarioJob(recipeWithId(idB), example, {
        ...DEFAULT_WRITER_OPTIONS,
        maxAttempts: 1,
      }),
    ];
    const done: ScenarioJob[] = [];
    await runBatchRounds(jobs, model, (job) => {
      done.push(job);
      return Promise.resolve();
    });
    expect(jobs[0].failure).toBe('błąd API: overloaded');
    expect(() => jobs[0].outcome()).toThrow('overloaded');
    expect(done).toHaveLength(2);
  });
});

describe('Anthropic Message Batches — budżet i rozliczenie', () => {
  const call: WriterModelCall = {
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    system: 'zasady',
    user: 'przepis',
    schema: { type: 'object' },
    maxTokens: 1000,
  };
  const worst = worstCaseMicroUsd(call, 0.5);
  const message = (text: string) =>
    ({
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 1000,
        output_tokens: 100,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }) as unknown as Anthropic.Message;

  /** Klient z paczkami kończącymi się od razu; pozycja „x-bad” = błąd. */
  const fakeClient = (created: string[][], failCreate = false) =>
    ({
      messages: {
        batches: {
          create: (body: { requests: { custom_id: string }[] }) => {
            if (failCreate) return Promise.reject(new Error('400 invalid'));
            created.push(body.requests.map((r) => r.custom_id));
            return Promise.resolve({
              id: `b${created.length}`,
              processing_status: 'in_progress',
            });
          },
          retrieve: () =>
            Promise.resolve({
              processing_status: 'ended',
              request_counts: {
                succeeded: 0,
                errored: 0,
                expired: 0,
                canceled: 0,
              },
            }),
          results: () => {
            const ids = created[created.length - 1];
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
                        result: {
                          type: 'succeeded',
                          message: message('{"a":1}'),
                        },
                      };
                }
              })(),
            );
          },
        },
      },
    }) as unknown as Anthropic;

  const noSleep = { sleep: () => Promise.resolve() };

  it('paczka bierze tyle pozycji, ile mieści budżet; reszta idzie następną paczką', async () => {
    const created: string[][] = [];
    // Miejsce na JEDNĄ rezerwację naraz — dwie pozycje = dwie paczki.
    const guard = new BudgetGuard(worst + worst / 2);
    const model = new AnthropicBatchModel(
      fakeClient(created),
      guard,
      undefined,
      noSleep,
    );
    const results = await model.run([
      { id: 'a-r1', call },
      { id: 'b-r1', call },
    ]);
    expect(created).toEqual([['a-r1'], ['b-r1']]);
    expect([...results.values()].every((r) => r.ok)).toBe(true);
    // Sonnet 5.5: (1000 × 2 + 100 × 10) µ$ × 0,5 (paczka) = 1500 µ$ za pozycję.
    expect(guard.spentMicroUsd).toBe(3000);
  });

  it('błędna pozycja nic nie kosztuje, a brak budżetu nawet na jedną = błąd budżetu', async () => {
    const created: string[][] = [];
    const guard = new BudgetGuard(worst * 3);
    const model = new AnthropicBatchModel(
      fakeClient(created),
      guard,
      undefined,
      noSleep,
    );
    const results = await model.run([
      { id: 'a-r1', call },
      { id: 'x-bad-r1', call },
    ]);
    expect(results.get('x-bad-r1')).toMatchObject({ ok: false });
    expect(guard.spentMicroUsd).toBe(1500);

    const poor = new AnthropicBatchModel(
      fakeClient([]),
      new BudgetGuard(worst - 1),
      undefined,
      noSleep,
    );
    const none = await poor.run([{ id: 'a-r1', call }]);
    expect(none.get('a-r1')).toEqual({
      ok: false,
      error: 'budżet wyczerpany',
      budget: true,
    });
  });

  it('paczka nieprzyjęta przez API nic nie kosztuje i nie wysadza przebiegu', async () => {
    const guard = new BudgetGuard(worst * 3);
    const model = new AnthropicBatchModel(
      fakeClient([], true),
      guard,
      undefined,
      noSleep,
    );
    const results = await model.run([{ id: 'a-r1', call }]);
    expect(results.get('a-r1')).toEqual({
      ok: false,
      error: 'paczka przerwana',
    });
    expect(guard.spentMicroUsd).toBe(0);
  });
});
