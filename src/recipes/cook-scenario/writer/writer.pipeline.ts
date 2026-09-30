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
  writerModel: 'claude-opus-5-5',
  writerEffort: 'medium',
  reviewerModel: 'claude-sonnet-5-5',
  reviewerEffort: 'medium',
  maxAttempts: 3,
  minScore: 4,
  maxTokens: 16_000,
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
 * Jeden przepis przez cały system: autor → walidatory → recenzent, z
 * poprawkami. Nie dotyka bazy — wynik zapisuje `saveWrittenScenario`.
 * Błąd API (sieć, limit) leci wyżej: wołający decyduje, czy ponowić przepis.
 */
export async function writeCookScenario(
  model: WriterModel,
  recipe: WriterRecipe,
  example: WriterExample,
  options: WriterOptions = DEFAULT_WRITER_OPTIONS,
): Promise<WriteOutcome> {
  const system = buildWriterSystem(example);
  const attempts: AttemptReport[] = [];
  let usage = ZERO_USAGE;
  let feedback: string[] = [];
  // Poprzednia odpowiedź autora (do poprawki zamiast pisania od zera)
  // i uwagi recenzenta do niej (żeby się z nich nie wycofywał).
  let previous: unknown = null;
  let previousIssues: string[] = [];
  let lastContent: CookScenarioContent | null = null;
  let lastReview: Review | null = null;
  let lastWarnings: string[] = [];

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const written = await model.complete({
      model: options.writerModel,
      effort: options.writerEffort,
      system,
      user: buildWriterUser(recipe, feedback, previous),
      schema: WRITER_OUTPUT_SCHEMA,
      maxTokens: options.maxTokens,
    });
    usage = addUsage(usage, written.usage);
    const report: AttemptReport = {
      attempt,
      decision: null,
      errors: [],
      warnings: [],
      review: null,
      usage: written.usage,
    };
    attempts.push(report);

    if (written.stopReason === 'max_tokens') {
      report.errors.push(
        'odpowiedź ucięta (max_tokens) — pisz zwięźlej, najwyżej 30 kroków',
      );
      feedback = report.errors;
      continue;
    }

    previous =
      typeof written.json === 'object' && written.json !== null
        ? written.json
        : null;
    const resolved = resolveWriterOutput(recipe, written.json);
    report.decision = resolved.decision;
    report.errors.push(...resolved.errors);

    if (resolved.decision === 'SKIP' && resolved.errors.length === 0) {
      const blocked = skipGuard(recipe);
      if (!blocked) {
        return {
          status: 'SKIPPED',
          content: null,
          skipReason: resolved.skipReason,
          review: null,
          warnings: [],
          attempts,
          usage,
        };
      }
      report.errors.push(blocked);
    }
    if (report.errors.length || !resolved.content) {
      feedback = report.errors.slice(0, FEEDBACK_LIMIT);
      continue;
    }

    const quality = qualityChecks(recipe, resolved.content);
    report.errors.push(...quality.errors);
    report.warnings = quality.warnings;
    if (quality.errors.length) {
      feedback = quality.errors.slice(0, FEEDBACK_LIMIT);
      continue;
    }
    lastContent = resolved.content;
    lastWarnings = quality.warnings;

    const reviewed = await model.complete({
      model: options.reviewerModel,
      effort: options.reviewerEffort,
      system: REVIEWER_SYSTEM,
      user: buildReviewerUser(
        recipe,
        resolved.content,
        quality.warnings,
        previousIssues,
      ),
      schema: REVIEWER_OUTPUT_SCHEMA,
      maxTokens: options.maxTokens,
    });
    usage = addUsage(usage, reviewed.usage);
    report.usage = addUsage(report.usage, reviewed.usage);
    const review = parseReview(reviewed.json);
    if (!review) {
      // Zepsuta odpowiedź recenzenta nie jest winą autora — bez oceny nie
      // przepuszczamy, ale też nie przepisujemy treści w kółko.
      report.errors.push('recenzent: odpowiedź niezgodna ze schematem');
      break;
    }
    report.review = review;
    lastReview = review;
    if (reviewPasses(review, options.minScore)) {
      return {
        status: 'VALIDATED',
        content: resolved.content,
        skipReason: null,
        review,
        warnings: quality.warnings,
        attempts,
        usage,
      };
    }
    feedback = reviewFeedback(review).slice(0, FEEDBACK_LIMIT);
    previousIssues = review.issues.map(
      (issue) =>
        `${issue.stepId ? `[${issue.stepId}] ` : ''}${issue.severity}: ${issue.text}`,
    );
  }

  return {
    status: 'REJECTED',
    content: lastContent,
    skipReason: null,
    review: lastReview,
    warnings: lastWarnings,
    attempts,
    usage,
  };
}
