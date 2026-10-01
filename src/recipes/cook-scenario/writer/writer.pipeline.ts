import { randomUUID } from 'node:crypto';
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
  /**
   * VALIDATED z wersji w odwodzie: bez BLOCKER/MAJOR, ale ocena poniżej
   * progu — publikacja wymaga świadomej zgody (`publishWrittenScenario`).
   */
  belowThreshold?: boolean;
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

/** Czy recenzja ma coś, co blokuje publikację (BLOCKER albo MAJOR). */
const isBlocking = (review: Review) =>
  review.issues.some(
    (issue) => issue.severity === 'BLOCKER' || issue.severity === 'MAJOR',
  );

/**
 * Uwagi do poprawki. Zwykle tylko BLOCKER/MAJOR — MINOR to szum. Gdy
 * recenzent dał ocenę poniżej progu bez żadnej poważnej uwagi (próba .5,
 * pizza: 3/5 i same MINOR), autor dostaje MINOR — inaczej nie miałby czego
 * poprawić i kręciłby się w kółko.
 */
const reviewFeedback = (review: Review, withMinor = false) => [
  `Recenzent ocenił na ${review.score}/5: ${review.summary}`,
  ...review.issues
    .filter((issue) => withMinor || issue.severity !== 'MINOR')
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
/**
 * Stan zadania do zapisania na dysku (dziennik przebiegu paczek) — same
 * dane, bez funkcji. `pendingReviewAttempt` wskazuje próbę w `attempts`
 * (raport recenzji dopisuje się do tego samego obiektu).
 */
export interface JobState {
  jobId: string;
  recipe: WriterRecipe;
  attempts: AttemptReport[];
  usage: WriterUsage;
  feedback: string[];
  previous: unknown;
  previousIssues: string[];
  lastContent: CookScenarioContent | null;
  lastReview: Review | null;
  lastWarnings: string[];
  pendingReview: {
    content: CookScenarioContent;
    warnings: string[];
    attemptIndex: number;
  } | null;
  result: WriteOutcome | null;
  failure: string | null;
  /** Ile razy z rzędu pozycja paczki tego zadania padła po stronie API. */
  transportErrors?: number;
  /** Ile razy z rzędu recenzja tej treści wróciła ucięta albo zepsuta. */
  reviewFailures?: number;
  /** Ostatnia recenzja ucięta (max_tokens) — ponowienie z wyższym limitem. */
  reviewTruncated?: boolean;
  /** Ostatnia odpowiedź autora ucięta — kolejna próba z wyższym limitem. */
  writerTruncated?: boolean;
  /** Ostatnia wersja bez BLOCKER/MAJOR — wynik, gdy dalsze poprawki padną. */
  acceptable?: {
    content: CookScenarioContent;
    review: Review;
    warnings: string[];
  } | null;
}

/** Tyle błędów API pod rząd na zadanie, zanim uznamy je za nieudane. */
export const MAX_TRANSPORT_ERRORS = 3;

/**
 * Tyle razy ponawiamy SAMĄ recenzję, gdy wróci ucięta (max_tokens),
 * niezgodna ze schematem albo niespójna — to nie wina autora, nie zużywa
 * jego prób (review Codexa, noc 30.09). Raz: przy systematycznym ucinaniu
 * więcej ponowień tylko mnoży koszt (przegląd nocny).
 */
export const MAX_REVIEW_FAILURES = 1;

/**
 * Ponowienie po uciętej odpowiedzi (recenzji albo autora) dostaje tyle razy
 * wyższy limit tokenów — długie przepisy (barszcz z uszkami, kulebiak)
 * nie mieszczą myślenia i scenariusza w 12 tys. (próba w7).
 */
const TRUNCATED_REVIEW_BOOST = 1.5;

export class ScenarioJob {
  /** Klucz zadania — zapis tego samego zadania drugi raz nic nie dopisuje. */
  readonly jobId: string;
  private readonly system: string;
  private attempts: AttemptReport[] = [];
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
  private transportErrors = 0;
  private reviewFailures = 0;
  private reviewTruncated = false;
  private writerTruncated = false;
  private acceptable: JobState['acceptable'] = null;

  constructor(
    readonly recipe: WriterRecipe,
    example: WriterExample,
    private readonly options: WriterOptions = DEFAULT_WRITER_OPTIONS,
    jobId: string = randomUUID(),
  ) {
    this.system = buildWriterSystem(example);
    this.jobId = jobId;
  }

  /** Stan do dziennika (kopia przez JSON — bez wspólnych referencji). */
  snapshot(): JobState {
    const pending = this.pendingReview;
    return JSON.parse(
      JSON.stringify({
        jobId: this.jobId,
        recipe: this.recipe,
        attempts: this.attempts,
        usage: this.usage,
        feedback: this.feedback,
        previous: this.previous,
        previousIssues: this.previousIssues,
        lastContent: this.lastContent,
        lastReview: this.lastReview,
        lastWarnings: this.lastWarnings,
        pendingReview: pending
          ? {
              content: pending.content,
              warnings: pending.warnings,
              attemptIndex: this.attempts.indexOf(pending.report),
            }
          : null,
        result: this.result,
        failure: this.failure,
        transportErrors: this.transportErrors,
        reviewFailures: this.reviewFailures,
        reviewTruncated: this.reviewTruncated,
        writerTruncated: this.writerTruncated,
        acceptable: this.acceptable,
      } satisfies JobState),
    ) as JobState;
  }

  /** Zadanie odtworzone z dziennika — dalej dokładnie tam, gdzie stanęło. */
  static restore(
    state: JobState,
    example: WriterExample,
    options: WriterOptions = DEFAULT_WRITER_OPTIONS,
  ): ScenarioJob {
    const job = new ScenarioJob(state.recipe, example, options, state.jobId);
    job.attempts = state.attempts;
    job.usage = state.usage;
    job.feedback = state.feedback;
    job.previous = state.previous;
    job.previousIssues = state.previousIssues;
    job.lastContent = state.lastContent;
    job.lastReview = state.lastReview;
    job.lastWarnings = state.lastWarnings;
    job.pendingReview = state.pendingReview
      ? {
          content: state.pendingReview.content,
          warnings: state.pendingReview.warnings,
          report: job.attempts[state.pendingReview.attemptIndex],
        }
      : null;
    job.result = state.result;
    job.failure = state.failure;
    job.transportErrors = state.transportErrors ?? 0;
    job.reviewFailures = state.reviewFailures ?? 0;
    job.reviewTruncated = state.reviewTruncated ?? false;
    job.writerTruncated = state.writerTruncated ?? false;
    job.acceptable = state.acceptable ?? null;
    return job;
  }

  get done(): boolean {
    return this.result !== null || this.failure !== null;
  }

  /** Zadanie ma wynik (VALIDATED/REJECTED/SKIPPED) — do zapisu w bazie. */
  get hasResult(): boolean {
    return this.result !== null;
  }

  /** Ile zadanie kosztowało dotąd (także w toku) — do bramki kosztu serii. */
  get spentMicroUsd(): number {
    return this.usage.costMicroUsd;
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
        maxTokens: this.reviewTruncated
          ? Math.round(this.options.maxTokens * TRUNCATED_REVIEW_BOOST)
          : this.options.maxTokens,
      };
    }
    return {
      model: this.options.writerModel,
      effort: this.options.writerEffort,
      system: this.system,
      user: buildWriterUser(this.recipe, this.feedback, this.previous),
      schema: WRITER_OUTPUT_SCHEMA,
      maxTokens: this.writerTruncated
        ? Math.round(this.options.maxTokens * TRUNCATED_REVIEW_BOOST)
        : this.options.maxTokens,
    };
  }

  accept(response: WriterModelResult): void {
    if (this.done) throw new Error('zadanie już zakończone');
    this.transportErrors = 0;
    if (this.pendingReview) this.acceptReview(response);
    else this.acceptWriter(response);
  }

  /** Przerywa zadanie po błędzie API — bez wyniku, do ponowienia później. */
  abort(reason: string): void {
    if (!this.done) this.failure = reason;
  }

  /**
   * Pozycja paczki padła po stronie API (przeciążenie, wygaśnięcie): zadanie
   * zostaje w miejscu i to samo wywołanie idzie w następnej rundzie;
   * dopiero `MAX_TRANSPORT_ERRORS` pod rząd kończy je jako nieudane.
   */
  transportFailure(reason: string): void {
    if (this.done) return;
    this.transportErrors += 1;
    if (this.transportErrors >= MAX_TRANSPORT_ERRORS) this.abort(reason);
  }

  /** Wznowienie daje nieudanemu zadaniu nową serię prób. */
  resetFailure(): void {
    if (this.result) return;
    this.failure = null;
    this.transportErrors = 0;
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

    // Raz ucięty = długi przepis: wyższy limit do końca zadania (przegląd
    // nocny — inaczej trzecia próba wracała do 12 tys. i znów się ucinała).
    this.writerTruncated ||= written.stopReason === 'max_tokens';
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
    this.usage = addUsage(this.usage, reviewed.usage);
    report.usage = addUsage(report.usage, reviewed.usage);
    const truncated = reviewed.stopReason === 'max_tokens';
    const review = truncated ? null : parseReview(reviewed.json);
    // Ocena musi zgadzać się z wagami (prompt): poniżej progu bez BLOCKER/
    // MAJOR wolno tylko o jeden punkt i tylko z uwagami do poprawy — „1/5
    // bez uwag” to recenzja zepsuta, nie wynik (przegląd nocny).
    const inconsistent =
      review !== null &&
      !reviewPasses(review, this.options.minScore) &&
      !isBlocking(review) &&
      (review.score < this.options.minScore - 1 || !review.issues.length);
    if (!review || inconsistent) {
      // Ucięta, zepsuta albo niespójna recenzja nie jest winą autora:
      // ponawiamy SAMĄ recenzję tej samej treści (review Codexa, noc 30.09).
      const why = truncated
        ? 'recenzent: odpowiedź ucięta (max_tokens)'
        : inconsistent
          ? `recenzent: ocena ${review.score}/5 bez BLOCKER/MAJOR${review.issues.length ? '' : ' i bez uwag'} — niespójna z zasadami oceny`
          : 'recenzent: odpowiedź niezgodna ze schematem';
      this.reviewFailures += 1;
      this.reviewTruncated = truncated;
      if (this.reviewFailures <= MAX_REVIEW_FAILURES) {
        report.warnings = [...report.warnings, `${why} — ponawiam recenzję`];
        return;
      }
      this.pendingReview = null;
      report.errors.push(why);
      this.reject();
      return;
    }
    this.pendingReview = null;
    this.reviewFailures = 0;
    this.reviewTruncated = false;
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
    if (!isBlocking(review)) {
      // Ocena o punkt poniżej progu, same MINOR: nic nie blokuje publikacji.
      // Autor próbuje je poprawić, a NAJLEPSZA taka wersja zostaje
      // w odwodzie — gdyby dalsze poprawki padły, wynikiem jest ona
      // (oznaczona `belowThreshold`), nie REJECTED.
      if (!this.acceptable || review.score >= this.acceptable.review.score) {
        this.acceptable = { content, review, warnings };
      }
      this.retryOrReject(reviewFeedback(review, true));
      return;
    }
    this.retryOrReject(reviewFeedback(review));
  }

  private retryOrReject(feedback: string[]): void {
    this.feedback = feedback.slice(0, FEEDBACK_LIMIT);
    if (this.attempts.length >= this.options.maxAttempts) this.reject();
  }

  private reject(): void {
    if (this.acceptable) {
      // Wersja bez BLOCKER/MAJOR z wcześniejszej próby — publikowalna
      // według zasad recenzji; ocena zostaje w raporcie dla panelu.
      this.finish({
        status: 'VALIDATED',
        content: this.acceptable.content,
        skipReason: null,
        review: this.acceptable.review,
        warnings: this.acceptable.warnings,
        belowThreshold: this.acceptable.review.score < this.options.minScore,
      });
      return;
    }
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
