import type { CookScenarioContent } from '../cook-scenario.types';
import type { ScenarioJob } from './writer.pipeline';

/**
 * Raport przebiegu paczek budowany z CAŁEJ serii (review Codexa): po
 * wznowieniu część przepisów zapisała się w poprzednim uruchomieniu, a zapis
 * idempotentny (duplikat po padzie) nic nie dopisuje — raport składany
 * „po drodze” pokazywałby tylko nowe. Dlatego: wszystkie zadania serii +
 * status i wersja z BAZY (po kluczu zadania).
 */
export interface ReportEntry {
  recipeId: string;
  title: string;
  status: string;
  version?: number;
  score?: number;
  attempts?: number;
  costUsd?: number;
  skipReason?: string | null;
  warnings?: string[];
  review?: unknown;
  errors?: string[];
  content?: CookScenarioContent | null;
  failure?: string;
}

export function batchReport(
  jobs: ScenarioJob[],
  saved: Map<string, { version: number; status: string }>,
): ReportEntry[] {
  return jobs.map((job): ReportEntry => {
    const base = { recipeId: job.recipe.id, title: job.recipe.title };
    if (job.failure) {
      return {
        ...base,
        status: job.failure === 'budżet wyczerpany' ? 'BUDGET' : 'FAILED',
        failure: job.failure,
      };
    }
    if (!job.hasResult) return { ...base, status: 'PENDING' };
    const outcome = job.outcome();
    const row = saved.get(job.jobId);
    return {
      ...base,
      // Wynik jest, ale w bazie go nie ma — przebieg stanął na zapisie.
      status: row?.status ?? 'UNSAVED',
      version: row?.version,
      score: outcome.review?.score,
      attempts: outcome.attempts.length,
      costUsd: outcome.usage.costMicroUsd / 1_000_000,
      skipReason: outcome.skipReason,
      warnings: outcome.warnings,
      review: outcome.review,
      errors: outcome.attempts.flatMap((a) => a.errors),
      content: outcome.content,
    };
  });
}
