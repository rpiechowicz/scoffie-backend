import { clone, kotletExample } from './writer.fixtures.spec-helper';
import { ScenarioJob } from './writer.pipeline';
import { exampleOutput } from './writer.prompt';
import { batchReport } from './writer.report';
import type { WriterModelResult, WriterRecipe } from './writer.types';

const example = kotletExample();
const result = (json: unknown): WriterModelResult => ({
  json,
  stopReason: 'end_turn',
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costMicroUsd: 2000,
    priceKnown: true,
  },
});
const recipe = (id: string): WriterRecipe => ({ ...example.recipe, id });
const finished = (id: string) => {
  const job = new ScenarioJob(recipe(id), example);
  job.accept(result(clone(exampleOutput(example.recipe, example.content))));
  job.accept(result({ score: 5, issues: [], summary: 'ok' }));
  return job;
};

describe('system pisania — raport serii paczek', () => {
  it('obejmuje zadania z poprzedniego uruchomienia (wznowienie), duplikaty zapisu i nieudane', () => {
    // Zapisany przed przerwą (odtworzony z dziennika) + nowy + zapis-duplikat.
    const before = ScenarioJob.restore(finished('a').snapshot(), example);
    const now = finished('b');
    const duplicate = finished('c');
    const failed = new ScenarioJob(recipe('d'), example);
    failed.abort('błąd API: overloaded');
    const pending = new ScenarioJob(recipe('e'), example);
    const unsaved = finished('f');
    const saved = new Map([
      [before.jobId, { version: 3, status: 'VALIDATED' }],
      [now.jobId, { version: 1, status: 'VALIDATED' }],
      [duplicate.jobId, { version: 2, status: 'STALE' }],
    ]);
    const report = batchReport(
      [before, now, duplicate, failed, pending, unsaved],
      saved,
    );
    expect(report.map((r) => [r.recipeId, r.status, r.version])).toEqual([
      ['a', 'VALIDATED', 3],
      ['b', 'VALIDATED', 1],
      ['c', 'STALE', 2],
      ['d', 'FAILED', undefined],
      ['e', 'PENDING', undefined],
      ['f', 'UNSAVED', undefined],
    ]);
    expect(report[0]).toMatchObject({ score: 5, attempts: 1, costUsd: 0.004 });
  });
});
