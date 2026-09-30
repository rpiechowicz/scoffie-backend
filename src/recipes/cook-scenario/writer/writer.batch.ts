import type Anthropic from '@anthropic-ai/sdk';
import {
  BATCH_PRICE_MULTIPLIER,
  messageParams,
  resultFromMessage,
} from './writer.anthropic';
import { worstCaseMicroUsd, type BudgetGuard } from './writer.budget';
import type { JobState, ScenarioJob } from './writer.pipeline';
import type { WriterModelCall, WriterModelResult } from './writer.types';

/**
 * Batch API dla systemu pisania (katalog, E3b): setki przepisów naraz za
 * pół ceny, wynik zwykle w kilkanaście minut, najpóźniej w 24 h.
 *
 * Przebieg to RUNDY: w każdej zbieramy następne potrzebne wywołanie z każdego
 * niezakończonego zadania (autor albo recenzent) i wysyłamy je paczkami.
 * Zadanie (`ScenarioJob`) jest to samo co przy wywołaniach na żywo, więc
 * zasady, poprawki i recenzja działają identycznie — różni się transport.
 *
 * Pieniądze nie giną (review Codexa, 30.09):
 * - wszystkie wyniki rundy trafiają do zadań PRZED zapisami; zapis każdego
 *   przepisu osobno, z ponowieniem, idempotentnie (klucz zadania);
 * - każdy kłopot transportu (paczka nieprzyjęta, zerwane odpytywanie, brak
 *   budżetu) ZATRZYMUJE przebieg bez porzucania zadań — dziennik na dysku
 *   ma ich stan i id paczek w locie, a `--resume` odbiera opłacone paczki
 *   zamiast wysyłać je drugi raz.
 */

export interface BatchCall {
  /** `custom_id` pozycji paczki: `[a-zA-Z0-9_-]{1,64}`. */
  id: string;
  call: WriterModelCall;
}

export type BatchCallResult =
  { ok: true; result: WriterModelResult } | { ok: false; error: string };

/** Paczka przyjęta przez API, której wyników jeszcze nie odebrano. */
export interface InflightBatch {
  batchId: string;
  ids: string[];
  /** Zarezerwowany najgorszy koszt — przy wznowieniu wraca do budżetu. */
  reservedMicroUsd: number;
}

export interface BatchRunResult {
  results: Map<string, BatchCallResult>;
  /** Przyjęte, a nieodebrane (błąd sieci) — do odebrania przy wznowieniu. */
  interrupted: InflightBatch[];
  /** Dlaczego przebieg staje: brak budżetu albo transport; `null` = całość. */
  stopReason: 'budget' | 'transport' | null;
}

export interface BatchModel {
  run(
    calls: BatchCall[],
    onSubmitted?: (batch: InflightBatch) => Promise<void>,
  ): Promise<BatchRunResult>;
  /** Odbiór wyników paczki wysłanej wcześniej (wznowienie). */
  collect(batch: InflightBatch, calls: BatchCall[]): Promise<BatchRunResult>;
}

/** Id pozycji: przepis bez myślników + numer rundy (unikalne w paczce). */
export const batchCallId = (recipeId: string, round: number) =>
  `${recipeId.replace(/-/g, '')}-r${round}`;

export class BatchStoppedError extends Error {
  constructor(readonly reason: 'budget' | 'transport') {
    super(
      reason === 'budget'
        ? 'budżet wyczerpany — doładuj i wznów (--resume)'
        : 'przerwa w komunikacji z Batch API — wznów (--resume)',
    );
    this.name = 'BatchStoppedError';
  }
}

/** Dziennik przebiegu — wszystko, czego trzeba do wznowienia. */
export interface BatchJournal {
  version: 1;
  round: number;
  spentMicroUsd: number;
  /** Zadania już zapisane w bazie (albo zgłoszone jako błąd). */
  handled: string[];
  inflight: InflightBatch[];
  jobs: JobState[];
}

export interface BatchRunOptions {
  /** Zapis wyniku (albo zgłoszenie błędu) — może rzucić, ponawiamy. */
  onDone: (job: ScenarioJob) => Promise<void>;
  log?: (line: string) => void;
  /** Utrwalenie dziennika (po wysłaniu paczki i po każdej rundzie). */
  persist?: (journal: BatchJournal) => Promise<void>;
  spentMicroUsd?: () => number;
  /** Stan z dziennika przy wznowieniu. */
  resume?: Pick<BatchJournal, 'round' | 'handled' | 'inflight'>;
  /** Ile razy próbować zapisu jednego przepisu. */
  saveAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Prowadzi zadania rundami aż wszystkie się skończą albo przebieg stanie
 * (`BatchStoppedError` — stan jest w dzienniku, `--resume` dokończy).
 */
export async function runBatchRounds(
  jobs: ScenarioJob[],
  model: BatchModel,
  options: BatchRunOptions,
): Promise<void> {
  const log = options.log ?? (() => undefined);
  const sleep =
    options.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const handled = new Set(options.resume?.handled ?? []);
  let inflight: InflightBatch[] = [...(options.resume?.inflight ?? [])];
  let round = options.resume?.round ?? 0;

  const persist = async () => {
    await options.persist?.({
      version: 1,
      round,
      spentMicroUsd: options.spentMicroUsd?.() ?? 0,
      handled: [...handled],
      inflight,
      jobs: jobs.map((job) => job.snapshot()),
    });
  };

  const callsOf = (forRound: number) =>
    jobs.flatMap((job) => {
      const call = job.nextCall();
      return call
        ? [{ job, call, id: batchCallId(job.recipe.id, forRound) }]
        : [];
    });

  const apply = (
    pending: { job: ScenarioJob; id: string }[],
    results: Map<string, BatchCallResult>,
  ) => {
    for (const { job, id } of pending) {
      const outcome = results.get(id);
      if (!outcome) continue; // niewysłane / w locie — zadanie czeka
      if (outcome.ok) job.accept(outcome.result);
      else job.abort(outcome.error);
    }
  };

  // Zapisy po zastosowaniu WSZYSTKICH wyników; każdy przepis osobno.
  const saveDone = async () => {
    const attempts = options.saveAttempts ?? 3;
    for (const job of jobs) {
      if (!job.done || handled.has(job.jobId)) continue;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          await options.onDone(job);
          handled.add(job.jobId);
          break;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          log(
            `zapis ${job.recipe.id} nieudany (${attempt}/${attempts}): ${message}`,
          );
          if (attempt < attempts) await sleep(2000 * attempt);
        }
      }
    }
    await persist();
  };

  // Wznowienie: najpierw odbiór paczek opłaconych przed przerwą.
  if (inflight.length) {
    const pending = callsOf(round);
    const byId = new Map(pending.map((entry) => [entry.id, entry]));
    const still: InflightBatch[] = [];
    for (const batch of inflight) {
      const calls = batch.ids.flatMap((id) => {
        const entry = byId.get(id);
        return entry ? [{ id, call: entry.call }] : [];
      });
      log(
        `odbiór paczki ${batch.batchId} sprzed przerwy (${calls.length} pozycji)`,
      );
      const outcome = await model.collect(batch, calls);
      apply(pending, outcome.results);
      still.push(...outcome.interrupted);
    }
    inflight = still;
    await saveDone();
    if (inflight.length) throw new BatchStoppedError('transport');
  }

  // Zadania gotowe, a niezapisane (np. baza padła przed przerwą).
  await saveDone();

  for (;;) {
    const pending = callsOf(round + 1);
    if (!pending.length) return;
    round += 1;
    log(`runda ${round}: ${pending.length} wywołań`);
    const outcome = await model.run(
      pending.map(({ id, call }) => ({ id, call })),
      async (batch) => {
        inflight.push(batch);
        await persist();
      },
    );
    apply(pending, outcome.results);
    inflight = outcome.interrupted;
    await saveDone();
    if (outcome.stopReason) throw new BatchStoppedError(outcome.stopReason);
  }
}

export interface AnthropicBatchOptions {
  /** Co ile sekund pytać o stan paczki. */
  pollSeconds?: number;
  /** Ile razy ponowić odpytanie/odbiór po chwilowym błędzie. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * `BatchModel` na Anthropic Message Batches z twardym budżetem: przed
 * wysłaniem każda pozycja rezerwuje najgorszy koszt (po cenie paczkowej).
 * Paczka bierze tylko tyle pozycji, ile mieści się w budżecie; resztę
 * wysyłamy następną paczką, gdy rozliczenie zwolni rezerwację. Gdy nic się
 * nie mieści — przebieg staje (`stopReason: 'budget'`), zadania czekają.
 */
export class AnthropicBatchModel implements BatchModel {
  private readonly pollMs: number;
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly client: Anthropic,
    private readonly guard: BudgetGuard,
    private readonly log: (line: string) => void = () => undefined,
    options: AnthropicBatchOptions = {},
  ) {
    this.pollMs = (options.pollSeconds ?? 30) * 1000;
    this.retries = options.retries ?? 8;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async run(
    calls: BatchCall[],
    onSubmitted?: (batch: InflightBatch) => Promise<void>,
  ): Promise<BatchRunResult> {
    const results = new Map<string, BatchCallResult>();
    let queue = [...calls];
    while (queue.length) {
      const chunk: { item: BatchCall; reserved: number }[] = [];
      const rest: BatchCall[] = [];
      for (const item of queue) {
        const reserved = worstCaseMicroUsd(item.call, BATCH_PRICE_MULTIPLIER);
        try {
          this.guard.reserve(reserved);
          chunk.push({ item, reserved });
        } catch {
          rest.push(item);
        }
      }
      if (!chunk.length) {
        return { results, interrupted: [], stopReason: 'budget' };
      }
      const reservedTotal = chunk.reduce((sum, e) => sum + e.reserved, 0);
      let batchId: string;
      try {
        const batch = await this.client.messages.batches.create({
          requests: chunk.map(({ item }) => ({
            custom_id: item.id,
            params: messageParams(item.call),
          })),
        });
        batchId = batch.id;
      } catch (error) {
        // Nieprzyjęta paczka nic nie kosztuje — zwalniamy rezerwację i stajemy.
        for (const entry of chunk) this.guard.settle(entry.reserved, 0);
        this.log(`paczka nieprzyjęta: ${messageOf(error)}`);
        return { results, interrupted: [], stopReason: 'transport' };
      }
      const inflight: InflightBatch = {
        batchId,
        ids: chunk.map((e) => e.item.id),
        reservedMicroUsd: reservedTotal,
      };
      this.log(`paczka ${batchId}: ${chunk.length} pozycji wysłana`);
      if (onSubmitted) await onSubmitted(inflight);
      const collected = await this.receive(inflight, chunk, results);
      if (!collected) {
        return { results, interrupted: [inflight], stopReason: 'transport' };
      }
      queue = rest;
    }
    return { results, interrupted: [], stopReason: null };
  }

  async collect(
    batch: InflightBatch,
    calls: BatchCall[],
  ): Promise<BatchRunResult> {
    // Rezerwacja z poprzedniego uruchomienia wraca do budżetu (rozliczenie
    // ją zdejmie i wpisze faktyczny koszt).
    this.guard.forceReserve(batch.reservedMicroUsd);
    const perItem = calls.length
      ? Math.floor(batch.reservedMicroUsd / calls.length)
      : 0;
    const chunk = calls.map((item) => ({ item, reserved: perItem }));
    const rest = batch.reservedMicroUsd - perItem * calls.length;
    if (rest > 0) this.guard.settle(rest, 0);
    const results = new Map<string, BatchCallResult>();
    const collected = await this.receive(batch, chunk, results);
    return collected
      ? { results, interrupted: [], stopReason: null }
      : { results, interrupted: [batch], stopReason: 'transport' };
  }

  /** Czeka na koniec paczki i odbiera wyniki; `false` = nie udało się. */
  private async receive(
    batch: InflightBatch,
    chunk: { item: BatchCall; reserved: number }[],
    results: Map<string, BatchCallResult>,
  ): Promise<boolean> {
    const byId = new Map(chunk.map((entry) => [entry.item.id, entry]));
    try {
      let lastLog = Date.now();
      for (;;) {
        const state = await this.retry(() =>
          this.client.messages.batches.retrieve(batch.batchId),
        );
        if (state.processing_status === 'ended') break;
        if (Date.now() - lastLog > 120_000) {
          const c = state.request_counts;
          this.log(
            `paczka ${batch.batchId}: gotowe ${c.succeeded + c.errored + c.expired + c.canceled}/${batch.ids.length}`,
          );
          lastLog = Date.now();
        }
        await this.sleep(this.pollMs);
      }
      const lines = await this.retry(() =>
        this.client.messages.batches.results(batch.batchId),
      );
      const received = new Map<string, BatchCallResult>();
      for await (const line of lines) {
        const entry = byId.get(line.custom_id);
        if (!entry) continue;
        if (line.result.type === 'succeeded') {
          received.set(line.custom_id, {
            ok: true,
            result: resultFromMessage(
              entry.item.call.model,
              line.result.message,
              BATCH_PRICE_MULTIPLIER,
            ),
          });
        } else {
          received.set(line.custom_id, {
            ok: false,
            error:
              line.result.type === 'errored'
                ? `błąd API: ${JSON.stringify(line.result.error).slice(0, 200)}`
                : `pozycja ${line.result.type}`,
          });
        }
      }
      // Rozliczenie dopiero po odebraniu CAŁOŚCI — urwany odbiór nie zostawia
      // połowy paczki rozliczonej, a połowy w dzienniku.
      for (const [id, entry] of byId) {
        const outcome = received.get(id) ?? {
          ok: false as const,
          error: 'brak pozycji w wynikach paczki',
        };
        // Błąd/wygaśnięcie pozycji nie jest płatne.
        this.guard.settle(
          entry.reserved,
          outcome.ok ? outcome.result.usage.costMicroUsd : 0,
        );
        results.set(id, outcome);
      }
      return true;
    } catch (error) {
      // Przyjęta, a nieodebrana: pieniądze mogły pójść — rezerwacja zostaje
      // w dzienniku (`reservedMicroUsd`); tu liczymy ją jako wydaną, żeby ten
      // proces nie wysłał więcej, niż wolno.
      for (const entry of byId.values()) {
        this.guard.settle(entry.reserved, entry.reserved);
      }
      this.log(`paczka ${batch.batchId} nieodebrana: ${messageOf(error)}`);
      return false;
    }
  }

  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    let delay = 5000;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        if (attempt >= this.retries) throw error;
        this.log(`ponawiam za ${delay / 1000} s: ${messageOf(error)}`);
        await this.sleep(delay);
        delay = Math.min(delay * 2, 300_000);
      }
    }
  }
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
