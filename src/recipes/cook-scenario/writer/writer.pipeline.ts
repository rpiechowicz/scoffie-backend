import type { CookScenarioContent } from '../cook-scenario.types';
import { qualityChecks, resolveWriterOutput, skipGuard } from './writer.checks';
import {
  buildReviewerUser,
  buildWriterSystem,
  buildWriterUser,
  REVIEWER_SYSTEM,
  type WriterExample,
} from './writer.prompt';
import {
  REVIEW_SEVERITIES,
  REVIEWER_OUTPUT_SCHEMA,
  WRITER_OUTPUT_SCHEMA,
  type ReviewSeverity,
} from './writer.schema';
import {
  addUsage,
  ZERO_USAGE,
  type WriterModel,
  type WriterModelCall,
  type WriterModelResult,
  type WriterRecipe,
  type WriterUsage,
} from './writer.types';

export interface WriterOptions {
  writerModel: string;
  writerEffort: WriterModelCall['effort'];
  reviewerModel: string;
  reviewerEffort: WriterModelCall['effort'];
  /** Ile razy autor pisze najwyżej (pierwsza wersja + poprawki). */
  maxAttempts: number;
  /** Najniższa ocena recenzenta, przy której scenariusz przechodzi. */
  minScore: number;
  maxTokens: number;
}

export const DEFAULT_WRITER_OPTIONS: WriterOptions = {
  // Rafał 30.09: Sonnet 5.5 — porównanie na pilocie 18/20 (Opus) vs 17/20
  // przy ~40% niższym koszcie; weryfikacja mocniejszym modelem później.
  writerModel: 'claude-sonnet-5-5',
  writerEffort: 'medium',
  reviewerModel: 'claude-sonnet-5-5',
  reviewerEffort: 'medium',
  maxAttempts: 3,
  minScore: 4,
  // Pilot: autor najwyżej ~5,2 tys. tokenów wyjścia (średnio 3,4 tys.) —
  // 12 tys. to ponad 2× zapasu, a ucięta odpowiedź i tak wraca do poprawki.
  maxTokens: 12_000,
};

export interface Review {
  score: number;
  issues: { stepId: string | null; severity: ReviewSeverity; text: string }[];
  summary: string;
}

export interface AttemptReport {
  attempt: number;
  decision: 'WRITE' | 'SKIP' | null;
  /** Błędy walidatorów twardych (odrzucają wersję). */
  errors: string[];
  warnings: string[];
  review: Review | null;
  usage: WriterUsage;
}

export interface WriteOutcome {
  status: 'VALIDATED' | 'REJECTED' | 'SKIPPED';
  /** Ostatnia treść, która przeszła walidatory (także przy REJECTED po recenzji). */
  content: CookScenarioContent | null;
  skipReason: string | null;
  review: Review | null;
  warnings: string[];
  attempts: AttemptReport[];
  usage: WriterUsage;
}

/** Najwięcej punktów z raportu wracających do autora — reszta to szum. */
const FEEDBACK_LIMIT = 25;

function parseReview(value: unknown): Review | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.score !== 'number' ||
    !Number.isInteger(raw.score) ||
    raw.score < 1 ||
    raw.score > 5 ||
    typeof raw.summary !== 'string' ||
    !Array.isArray(raw.issues)
  ) {
    return null;
  }
  const issues: Review['issues'] = [];
  for (const item of raw.issues as unknown[]) {
    if (typeof item !== 'object' || item === null) return null;
    const issue = item as Record<string, unknown>;
    if (
      typeof issue.text !== 'string' ||
      !(REVIEW_SEVERITIES as readonly unknown[]).includes(issue.severity) ||
      (issue.stepId !== null && typeof issue.stepId !== 'string')
    ) {
      return null;
    }
    issues.push({
      stepId: issue.stepId,
      severity: issue.severity as ReviewSeverity,
      text: issue.text,
    });
  }
  return { score: raw.score, issues, summary: raw.summary };
}

/**
 * Przechodzi tylko ocena >= progu BEZ żadnego BLOCKER ani MAJOR — schemat nie
 * wiąże oceny z wagą problemów, więc „4/5 + MAJOR” rozstrzyga kod, nie model
 * (review Codexa, E3a runda 3).
 */
const reviewPasses = (review: Review, minScore: number) =>
  review.score >= minScore &&
  !review.issues.some(
    (issue) => issue.severity === 'BLOCKER' || issue.severity === 'MAJOR',
  );

const reviewFeedback = (review: Review) => [
  `Recenzent ocenił na ${review.score}/5: ${review.summary}`,
  ...review.issues
    .filter((issue) => issue.severity !== 'MINOR')
    .map(
      (issue) =>
        `${issue.stepId ? `[${issue.stepId}] ` : ''}${issue.severity}: ${issue.text}`,
    ),
];

/**
 * Jeden przepis przez cały system — jako ZADANIE krok po kroku: `nextCall()`
 * mówi, jakiego wywołania modelu potrzebuje (autor albo recenzent),
 * `accept()` przyjmuje odpowiedź i przesuwa stan (walidatory, poprawki,
 * recenzja). Dzięki temu ta sama logika działa wywołanie po wywołaniu
 * (`writeCookScenario`) i w paczkach Batch API (`runBatchRounds`, setki
 * przepisów naraz) — wynik zależy tylko od odpowiedzi modelu, nie od trybu.
 * Nie dotyka bazy — wynik zapisuje `saveWrittenScenario`.
 */
export class ScenarioJob {
  private readonly system: string;
  private readonly attempts: AttemptReport[] = [];
  private usage = ZERO_USAGE;
  private feedback: string[] = [];
  // Poprzednia odpowiedź autora (do poprawki zamiast pisania od zera)
  // i uwagi recenzenta do niej (żeby się z nich nie wycofywał).
  private previous: unknown = null;
  private previousIssues: string[] = [];
  private lastContent: CookScenarioContent | null = null;
  private lastReview: Review | null = null;
  private lastWarnings: string[] = [];
  /** Treść czekająca na recenzję (po walidatorach). */
  private pendingReview: {
    content: CookScenarioContent;
    warnings: string[];
    report: AttemptReport;
  } | null = null;
  private result: WriteOutcome | null = null;
  /** Błąd API (sieć, limit, paczka) — zadanie przerwane bez wyniku. */
  failure: string | null = null;

  constructor(
    readonly recipe: WriterRecipe,
    example: WriterExample,
    private readonly options: WriterOptions = DEFAULT_WRITER_OPTIONS,
  ) {
    this.system = buildWriterSystem(example);
  }

  get done(): boolean {
    return this.result !== null || this.failure !== null;
  }

  /** Następne potrzebne wywołanie modelu albo `null`, gdy zadanie skończone. */
  nextCall(): WriterModelCall | null {
    if (this.done) return null;
    if (this.pendingReview) {
      return {
        model: this.options.reviewerModel,
        effort: this.options.reviewerEffort,
        system: REVIEWER_SYSTEM,
        user: buildReviewerUser(
          this.recipe,
          this.pendingReview.content,
          this.pendingReview.warnings,
          this.previousIssues,
        ),
        schema: REVIEWER_OUTPUT_SCHEMA,
        maxTokens: this.options.maxTokens,
      };
    }
    return {
      model: this.options.writerModel,
      effort: this.options.writerEffort,
      system: this.system,
      user: buildWriterUser(this.recipe, this.feedback, this.previous),
      schema: WRITER_OUTPUT_SCHEMA,
      maxTokens: this.options.maxTokens,
    };
  }

  accept(response: WriterModelResult): void {
    if (this.done) throw new Error('zadanie już zakończone');
    if (this.pendingReview) this.acceptReview(response);
    else this.acceptWriter(response);
  }

  /** Przerywa zadanie po błędzie API — bez wyniku, do ponowienia później. */
  abort(reason: string): void {
    if (!this.done) this.failure = reason;
  }

  outcome(): WriteOutcome {
    if (!this.result) {
      throw new Error(this.failure ?? 'zadanie jeszcze trwa');
    }
    return this.result;
  }

  private acceptWriter(written: WriterModelResult): void {
    this.usage = addUsage(this.usage, written.usage);
    const report: AttemptReport = {
      attempt: this.attempts.length + 1,
      decision: null,
      errors: [],
      warnings: [],
      review: null,
      usage: written.usage,
    };
    this.attempts.push(report);

    if (written.stopReason === 'max_tokens') {
      report.errors.push(
        'odpowiedź ucięta (max_tokens) — pisz zwięźlej, najwyżej 30 kroków',
      );
      this.retryOrReject(report.errors);
      return;
    }

    this.previous =
      typeof written.json === 'object' && written.json !== null
        ? written.json
        : null;
    const resolved = resolveWriterOutput(this.recipe, written.json);
    report.decision = resolved.decision;
    report.errors.push(...resolved.errors);

    if (resolved.decision === 'SKIP' && resolved.errors.length === 0) {
      const blocked = skipGuard(this.recipe);
      if (!blocked) {
        this.finish({
          status: 'SKIPPED',
          content: null,
          skipReason: resolved.skipReason,
          review: null,
          warnings: [],
        });
        return;
      }
      report.errors.push(blocked);
    }
    if (report.errors.length || !resolved.content) {
      this.retryOrReject(report.errors);
      return;
    }

    const quality = qualityChecks(this.recipe, resolved.content);
    report.errors.push(...quality.errors);
    report.warnings = quality.warnings;
    if (quality.errors.length) {
      this.retryOrReject(quality.errors);
      return;
    }
    this.lastContent = resolved.content;
    this.lastWarnings = quality.warnings;
    this.pendingReview = {
      content: resolved.content,
      warnings: quality.warnings,
      report,
    };
  }

  private acceptReview(reviewed: WriterModelResult): void {
    const { content, warnings, report } = this.pendingReview!;
    this.pendingReview = null;
    this.usage = addUsage(this.usage, reviewed.usage);
    report.usage = addUsage(report.usage, reviewed.usage);
    const review = parseReview(reviewed.json);
    if (!review) {
      // Zepsuta odpowiedź recenzenta nie jest winą autora — bez oceny nie
      // przepuszczamy, ale też nie przepisujemy treści w kółko.
      report.errors.push('recenzent: odpowiedź niezgodna ze schematem');
      this.reject();
      return;
    }
    report.review = review;
    this.lastReview = review;
    if (reviewPasses(review, this.options.minScore)) {
      this.finish({
        status: 'VALIDATED',
        content,
        skipReason: null,
        review,
        warnings,
      });
      return;
    }
    this.previousIssues = review.issues.map(
      (issue) =>
        `${issue.stepId ? `[${issue.stepId}] ` : ''}${issue.severity}: ${issue.text}`,
    );
    this.retryOrReject(reviewFeedback(review));
  }

  private retryOrReject(feedback: string[]): void {
    this.feedback = feedback.slice(0, FEEDBACK_LIMIT);
    if (this.attempts.length >= this.options.maxAttempts) this.reject();
  }

  private reject(): void {
    this.finish({
      status: 'REJECTED',
      content: this.lastContent,
      skipReason: null,
      review: this.lastReview,
      warnings: this.lastWarnings,
    });
  }

  private finish(outcome: Omit<WriteOutcome, 'attempts' | 'usage'>): void {
    this.result = { ...outcome, attempts: this.attempts, usage: this.usage };
  }
}

/**
 * Jeden przepis, wywołanie po wywołaniu. Błąd API (sieć, limit) leci wyżej:
 * wołający decyduje, czy ponowić przepis.
 */
export async function writeCookScenario(
  model: WriterModel,
  recipe: WriterRecipe,
  example: WriterExample,
  options: WriterOptions = DEFAULT_WRITER_OPTIONS,
): Promise<WriteOutcome> {
  const job = new ScenarioJob(recipe, example, options);
  for (let call = job.nextCall(); call; call = job.nextCall()) {
    job.accept(await model.complete(call));
  }
  return job.outcome();
}
