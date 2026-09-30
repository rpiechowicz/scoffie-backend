import type Anthropic from '@anthropic-ai/sdk';
import {
  AnthropicBatchModel,
  batchCallId,
  BatchStoppedError,
  runBatchRounds,
  type BatchCall,
  type BatchCallResult,
  type BatchJournal,
  type BatchHooks,
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
    hooks: BatchHooks = {},
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
    await hooks.onSubmitted?.(inflight);
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

  reconcile(): Promise<InflightBatch | null> {
    return Promise.resolve(null);
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

  it('błąd pozycji API jest ponawiany w kolejnych rundach; po 3 pod rząd przebieg jest NIEKOMPLETNY, a wznowienie daje nową serię prób', async () => {
    let failuresLeftForA = 5;
    const model: BatchModel = {
      run: (calls) =>
        Promise.resolve({
          results: new Map(
            calls.map((c): [string, BatchCallResult] => {
              if (c.id.startsWith(key(idA)) && failuresLeftForA > 0) {
                failuresLeftForA -= 1;
                return [c.id, { ok: false, error: 'błąd API: overloaded' }];
              }
              const isReview =
                c.call.model === DEFAULT_WRITER_OPTIONS.reviewerModel &&
                c.call.system.startsWith('Jesteś recenzentem');
              return [
                c.id,
                { ok: true, result: result(isReview ? review(5) : good()) },
              ];
            }),
          ),
          interrupted: [],
          stopReason: null,
        }),
      collect: () => Promise.reject(new Error('nieużywane')),
      reconcile: () => Promise.resolve(null),
    };
    const jobs = newJobs();
    const saved: string[] = [];
    let journal: BatchJournal | null = null;
    const options = {
      onDone: (job: ScenarioJob) => {
        saved.push(job.recipe.id);
        return Promise.resolve();
      },
      persist: (j: BatchJournal) => {
        journal = clone(j);
        return Promise.resolve();
      },
    };
    await expect(runBatchRounds(jobs, model, options)).rejects.toMatchObject({
      reason: 'incomplete',
    });
    // A: 3 błędy pod rząd → nieudane; B normalnie zapisany.
    expect(jobs[0].failure).toBe('błąd API: overloaded');
    expect(saved).toEqual([idB]);

    // Wznowienie: A dostaje nową serię prób (jeszcze 2 błędy, potem OK).
    const restored = journal!.jobs.map((st) =>
      ScenarioJob.restore(st, example),
    );
    await runBatchRounds(restored, model, { ...options, resume: journal! });
    expect(saved).toEqual([idB, idA]);
    expect(restored[0].outcome().status).toBe('VALIDATED');
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
      reconcile: () => Promise.reject(new Error('nie powinno wołać modelu')),
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
    ).run([{ id: 'a-r1', call }], {
      onSubmitted: (b) => {
        submitted.push(b);
        return Promise.resolve();
      },
    });
    expect(outcome.stopReason).toBe('transport');
    expect(outcome.interrupted).toEqual(submitted);
    // Jedna semantyka: rozliczone NIE zawiera paczki w locie — ta zostaje
    // zarezerwowana (proces nie wyda ponad limit), a w dzienniku osobno.
    expect(guard.spentMicroUsd).toBe(0);
    expect(guard.reservedMicroUsd).toBe(
      outcome.interrupted[0].reservedMicroUsd,
    );

    // Nowy proces (tak samo po padzie tuż po wysłaniu): start od rozliczonego,
    // rezerwacja wraca dokładnie raz przy odbiorze.
    const resumed = new BudgetGuard(worst * 3, guard.spentMicroUsd);
    const collected = await model(fakeClient(created), resumed).collect(
      outcome.interrupted[0],
      [{ id: 'a-r1', call }],
    );
    expect(collected.results.get('a-r1')).toMatchObject({ ok: true });
    expect(resumed.spentMicroUsd).toBe(ACTUAL);
    expect(resumed.reservedMicroUsd).toBe(0);
  });
});

describe('dziennik paczek — niezmienniki po awariach (review Codexa)', () => {
  // Klient, który na pozycje autora odpowiada dobrym scenariuszem kotleta,
  // a na recenzję oceną 5; `failResultsOf` = numery paczek bez odbioru.
  const writerText = JSON.stringify(good());
  const reviewText = JSON.stringify(review(5));
  const smartClient = (
    created: { ids: string[]; review: boolean[] }[],
    failResultsOf = new Set<number>(),
    createFaults: { lostResponse?: number; rejected?: number } = {},
  ) => {
    let createCalls = 0;
    return {
      messages: {
        batches: {
          create: (body: {
            requests: {
              custom_id: string;
              params: { system: { text: string }[] };
            }[];
          }) => {
            createCalls += 1;
            if (createFaults.rejected === createCalls) {
              return Promise.reject(new Error('ECONNREFUSED'));
            }
            created.push({
              ids: body.requests.map((r) => r.custom_id),
              review: body.requests.map((r) =>
                r.params.system[0].text.startsWith('Jesteś recenzentem'),
              ),
            });
            // Paczka przyjęta, ale odpowiedź „zginęła w sieci”.
            if (createFaults.lostResponse === createCalls) {
              return Promise.reject(new Error('socket hang up'));
            }
            return Promise.resolve({ id: `b${created.length}` });
          },
          // Paczki u „dostawcy”, od najnowszych.
          list: () =>
            (async function* () {
              for (let n = created.length; n >= 1; n -= 1) {
                await Promise.resolve();
                yield {
                  id: `b${n}`,
                  created_at: new Date().toISOString(),
                  processing_status: 'ended',
                  request_counts: {
                    processing: 0,
                    succeeded: created[n - 1].ids.length,
                    errored: 0,
                    canceled: 0,
                    expired: 0,
                  },
                };
              }
            })(),
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
          results: (batchId: string) => {
            const n = Number(batchId.slice(1));
            if (failResultsOf.has(n)) return Promise.reject(new Error('502'));
            const batch = created[n - 1];
            return Promise.resolve(
              (async function* () {
                for (const [i, id] of batch.ids.entries()) {
                  await Promise.resolve();
                  yield {
                    custom_id: id,
                    result: {
                      type: 'succeeded',
                      message: {
                        content: [
                          {
                            type: 'text',
                            text: batch.review[i] ? reviewText : writerText,
                          },
                        ],
                        stop_reason: 'end_turn',
                        usage: {
                          input_tokens: 1000,
                          output_tokens: 100,
                          cache_read_input_tokens: 0,
                          cache_creation_input_tokens: 0,
                        },
                      },
                    },
                  };
                }
              })(),
            );
          },
        },
      },
    } as unknown as Anthropic;
  };
  const oneCall = (job: ScenarioJob) => job.nextCall()!;
  // Sonnet 5.5 za pozycję w paczce: (1000 × 2 + 100 × 10) × 0,5 = 1500 µ$.
  const ACTUAL = 1500;

  const splitRun = (persist: (j: BatchJournal) => Promise<void>) => {
    const created: { ids: string[]; review: boolean[] }[] = [];
    const jobs = newJobs();
    const worst = worstCaseMicroUsd(oneCall(jobs[0]), 0.5);
    // Budżet na jedną pozycję naraz → każda runda dzieli się na paczki.
    const guard = new BudgetGuard(worst + worst / 2);
    const model = new AnthropicBatchModel(
      smartClient(created),
      guard,
      undefined,
      {
        sleep: noSleep,
      },
    );
    const run = runBatchRounds(jobs, model, {
      onDone: () => Promise.resolve(),
      persist,
      spentMicroUsd: () => guard.spentMicroUsd,
      sleep: noSleep,
    });
    return { run, created, jobs, guard };
  };

  it('dziennik chwilowo pada tuż po przyjęciu paczki: paczka i tak odebrana, przebieg kończy się bez strat', async () => {
    let failOnce = true;
    const { run, jobs } = splitRun((j) => {
      if (j.inflight.length && failOnce) {
        failOnce = false;
        return Promise.reject(new Error('chwilowo'));
      }
      return Promise.resolve();
    });
    await run;
    expect(jobs.map((j) => j.outcome().status)).toEqual([
      'VALIDATED',
      'VALIDATED',
    ]);
  });

  it('dziennik pada na stałe po przyjęciu paczki: paczka odebrana, NOWE nie idą, przebieg staje „journal”', async () => {
    let broken = false;
    const { run, created, jobs, guard } = splitRun((j) => {
      if (j.inflight.length) broken = true;
      return broken
        ? Promise.reject(new Error('dysk pełny'))
        : Promise.resolve();
    });
    await expect(run).rejects.toMatchObject({ reason: 'journal' });
    // Wysłana TYLKO pierwsza paczka — i jej wynik trafił do zadania.
    expect(created).toHaveLength(1);
    expect(jobs[0].nextCall()?.system).toMatch(/^Jesteś recenzentem/);
    expect(guard.spentMicroUsd).toBe(ACTUAL);
  });

  it('restart w trakcie drugiej paczki rundy: pierwsza liczy się dokładnie raz', async () => {
    const created: { ids: string[]; review: boolean[] }[] = [];
    const jobs = newJobs();
    const worst = worstCaseMicroUsd(oneCall(jobs[0]), 0.5);
    const limit = worst * 10;
    const guard = new BudgetGuard(worst + worst / 2);
    const journals: BatchJournal[] = [];
    const persist = (j: BatchJournal) => {
      journals.push(clone(j));
      return Promise.resolve();
    };
    // Paczka 1 odebrana, paczka 2 przyjęta, ale nieodebrana → stop.
    await expect(
      runBatchRounds(
        jobs,
        new AnthropicBatchModel(
          smartClient(created, new Set([2])),
          guard,
          undefined,
          {
            sleep: noSleep,
            retries: 1,
          },
        ),
        {
          onDone: () => Promise.resolve(),
          persist,
          spentMicroUsd: () => guard.spentMicroUsd,
        },
      ),
    ).rejects.toMatchObject({ reason: 'transport' });
    const last = journals[journals.length - 1];
    expect(last.spentMicroUsd).toBe(ACTUAL);
    expect(last.inflight.map((b) => b.batchId)).toEqual(['b2']);
    // Wynik paczki 1 jest już w stanie zadania (nie trzeba jej odbierać).
    expect(last.jobs[0].attempts).toHaveLength(1);

    // Nowy proces: budżet od rozliczonego, odbiór b2 dolicza TYLKO b2.
    const resumed = new BudgetGuard(limit, last.spentMicroUsd);
    const restored = last.jobs.map((st) => ScenarioJob.restore(st, example));
    const afterCollect: number[] = [];
    await runBatchRounds(
      restored,
      new AnthropicBatchModel(smartClient(created), resumed, undefined, {
        sleep: noSleep,
      }),
      {
        onDone: () => Promise.resolve(),
        persist: (j) => {
          afterCollect.push(j.spentMicroUsd);
          return Promise.resolve();
        },
        spentMicroUsd: () => resumed.spentMicroUsd,
        resume: last,
      },
    );
    expect(afterCollect[0]).toBe(2 * ACTUAL);
    expect(restored.map((j) => j.outcome().status)).toEqual([
      'VALIDATED',
      'VALIDATED',
    ]);
  });
  describe('wysyłka paczki o nieznanym wyniku', () => {
    const onDone = () => Promise.resolve();
    const start = (
      created: { ids: string[]; review: boolean[] }[],
      faults: { lostResponse?: number; rejected?: number },
    ) => {
      const journals: BatchJournal[] = [];
      const guard = new BudgetGuard(1e9);
      const run = runBatchRounds(
        newJobs(),
        new AnthropicBatchModel(
          smartClient(created, new Set(), faults),
          guard,
          undefined,
          {
            sleep: noSleep,
          },
        ),
        {
          onDone,
          persist: (j) => {
            journals.push(clone(j));
            return Promise.resolve();
          },
          spentMicroUsd: () => guard.spentMicroUsd,
          runId: 'abc123',
        },
      );
      return { run, journals };
    };
    const resumeFrom = async (
      journal: BatchJournal,
      created: { ids: string[]; review: boolean[] }[],
    ) => {
      const guard = new BudgetGuard(1e9, journal.spentMicroUsd);
      const jobs = journal.jobs.map((st) => ScenarioJob.restore(st, example));
      await runBatchRounds(
        jobs,
        new AnthropicBatchModel(smartClient(created), guard, undefined, {
          sleep: noSleep,
        }),
        {
          onDone,
          persist: () => Promise.resolve(),
          spentMicroUsd: () => guard.spentMicroUsd,
          resume: journal,
        },
      );
      return { jobs, guard };
    };

    it('paczkę przyjęto, a odpowiedź zginęła: wznowienie ją odnajduje i NIE wysyła ponownie', async () => {
      const created: { ids: string[]; review: boolean[] }[] = [];
      const { run, journals } = start(created, { lostResponse: 1 });
      await expect(run).rejects.toMatchObject({ reason: 'transport' });
      const last = journals[journals.length - 1];
      expect(last.submitting?.ids).toHaveLength(2);
      expect(last.inflight).toEqual([]);
      expect(created).toHaveLength(1);
      expect(created[0].ids[0]).toMatch(/-r1-abc123$/);

      const { jobs, guard } = await resumeFrom(last, created);
      // Autorów nie wysłano drugi raz — kolejna paczka to już recenzje.
      expect(created).toHaveLength(2);
      expect(created[1].review.every(Boolean)).toBe(true);
      expect(jobs.map((j) => j.outcome().status)).toEqual([
        'VALIDATED',
        'VALIDATED',
      ]);
      // 2 × autor + 2 × recenzja, każda pozycja policzona raz.
      expect(guard.spentMicroUsd).toBe(4 * ACTUAL);
    });

    it('paczki naprawdę nie przyjęto: wznowienie wysyła ją ponownie', async () => {
      const created: { ids: string[]; review: boolean[] }[] = [];
      const { run, journals } = start(created, { rejected: 1 });
      await expect(run).rejects.toMatchObject({ reason: 'transport' });
      const last = journals[journals.length - 1];
      expect(last.submitting).not.toBeNull();
      expect(created).toHaveLength(0);

      const { jobs } = await resumeFrom(last, created);
      expect(created[0].review.some(Boolean)).toBe(false);
      expect(jobs.map((j) => j.outcome().status)).toEqual([
        'VALIDATED',
        'VALIDATED',
      ]);
    });

    it('proces padł między przyjęciem paczki a zapisem jej id: zapowiedź w dzienniku wystarcza', async () => {
      const created: { ids: string[]; review: boolean[] }[] = [];
      const { run, journals } = start(created, {});
      await run;
      // Stan dziennika z chwili tuż przed `create` (zapowiedź, bez id paczki).
      const crashed = journals.find((j) => j.submitting && !j.inflight.length)!;
      expect(crashed.round).toBe(1);
      const before = created.length;

      const { jobs } = await resumeFrom(crashed, created);
      const sentAfter = created.slice(before);
      // Po wznowieniu żadna paczka autorów rundy 1 nie poszła drugi raz.
      expect(
        sentAfter.some((b) => b.ids.some((id) => id.endsWith('-r1-abc123'))),
      ).toBe(false);
      expect(jobs.map((j) => j.outcome().status)).toEqual([
        'VALIDATED',
        'VALIDATED',
      ]);
    });
  });
});
