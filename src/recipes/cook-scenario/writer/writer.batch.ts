import type Anthropic from '@anthropic-ai/sdk';
import {
  BATCH_PRICE_MULTIPLIER,
  messageParams,
  resultFromMessage,
} from './writer.anthropic';
import { worstCaseMicroUsd, type BudgetGuard } from './writer.budget';
import type { ScenarioJob } from './writer.pipeline';
import type { WriterModelCall, WriterModelResult } from './writer.types';

/**
 * Batch API dla systemu pisania (katalog, E3b): setki przepisów naraz za
 * pół ceny, wynik zwykle w kilkanaście minut, najpóźniej w 24 h.
 *
 * Przebieg to RUNDY: w każdej zbieramy następne potrzebne wywołanie z każdego
 * niezakończonego zadania (autor albo recenzent) i wysyłamy je jedną paczką.
 * Zadanie (`ScenarioJob`) jest to samo co przy wywołaniach na żywo, więc
 * zasady, poprawki i recenzja działają identycznie — różni się tylko transport.
 */

export interface BatchCall {
  /** `custom_id` pozycji paczki: `[a-zA-Z0-9_-]{1,64}`. */
  id: string;
  call: WriterModelCall;
}

export type BatchCallResult =
  | { ok: true; result: WriterModelResult }
  | { ok: false; error: string; budget?: boolean };

export interface BatchModel {
  run(calls: BatchCall[]): Promise<Map<string, BatchCallResult>>;
}

/** Id pozycji: przepis bez myślników + numer rundy (unikalne w paczce). */
export const batchCallId = (recipeId: string, round: number) =>
  `${recipeId.replace(/-/g, '')}-r${round}`;

/**
 * Prowadzi zadania rundami aż wszystkie się skończą. Po każdej rundzie
 * zadania, które właśnie się zakończyły, idą do `onDone` (zapis do bazy) —
 * przerwanie w połowie serii nie traci tego, co już gotowe.
 */
export async function runBatchRounds(
  jobs: ScenarioJob[],
  model: BatchModel,
  onDone: (job: ScenarioJob) => Promise<void>,
  log: (line: string) => void = () => undefined,
): Promise<void> {
  for (let round = 1; ; round += 1) {
    const pending = jobs.flatMap((job) => {
      const call = job.nextCall();
      return call ? [{ job, call, id: batchCallId(job.recipe.id, round) }] : [];
    });
    if (!pending.length) return;
    log(`runda ${round}: ${pending.length} wywołań`);
    const results = await model.run(
      pending.map(({ id, call }) => ({ id, call })),
    );
    for (const { job, id } of pending) {
      const outcome = results.get(id);
      if (!outcome) job.abort('brak wyniku w paczce');
      else if (!outcome.ok) job.abort(outcome.error);
      else job.accept(outcome.result);
      if (job.done) await onDone(job);
    }
  }
}

export interface AnthropicBatchOptions {
  /** Co ile sekund pytać o stan paczki. */
  pollSeconds?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * `BatchModel` na Anthropic Message Batches z twardym budżetem: przed
 * wysłaniem każda pozycja rezerwuje najgorszy koszt (po cenie paczkowej).
 * Paczka bierze tylko tyle pozycji, ile mieści się w budżecie; resztę
 * wysyłamy następną paczką, gdy rozliczenie zwolni rezerwację. Pozycja,
 * która nie mieści się nawet przy pustej rezerwacji, wraca jako błąd
 * budżetu (zadanie przerwane, do dokończenia po doładowaniu).
 */
export class AnthropicBatchModel implements BatchModel {
  private readonly pollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly client: Anthropic,
    private readonly guard: BudgetGuard,
    private readonly log: (line: string) => void = () => undefined,
    options: AnthropicBatchOptions = {},
  ) {
    this.pollMs = (options.pollSeconds ?? 30) * 1000;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async run(calls: BatchCall[]): Promise<Map<string, BatchCallResult>> {
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
        for (const item of rest) {
          results.set(item.id, {
            ok: false,
            error: 'budżet wyczerpany',
            budget: true,
          });
        }
        break;
      }
      await this.submit(chunk, results);
      queue = rest;
    }
    return results;
  }

  private async submit(
    chunk: { item: BatchCall; reserved: number }[],
    results: Map<string, BatchCallResult>,
  ): Promise<void> {
    const byId = new Map(chunk.map((entry) => [entry.item.id, entry]));
    const settled = new Set<string>();
    let created = false;
    try {
      const batch = await this.client.messages.batches.create({
        requests: chunk.map(({ item }) => ({
          custom_id: item.id,
          params: messageParams(item.call),
        })),
      });
      created = true;
      this.log(`paczka ${batch.id}: ${chunk.length} pozycji wysłana`);
      let state = batch;
      let lastLog = Date.now();
      while (state.processing_status !== 'ended') {
        await this.sleep(this.pollMs);
        state = await this.client.messages.batches.retrieve(batch.id);
        if (Date.now() - lastLog > 120_000) {
          const c = state.request_counts;
          this.log(
            `paczka ${batch.id}: gotowe ${c.succeeded + c.errored + c.expired + c.canceled}/${chunk.length}`,
          );
          lastLog = Date.now();
        }
      }
      for await (const line of await this.client.messages.batches.results(
        batch.id,
      )) {
        const entry = byId.get(line.custom_id);
        if (!entry) continue;
        settled.add(line.custom_id);
        if (line.result.type === 'succeeded') {
          const result = resultFromMessage(
            entry.item.call.model,
            line.result.message,
            BATCH_PRICE_MULTIPLIER,
          );
          this.guard.settle(entry.reserved, result.usage.costMicroUsd);
          results.set(line.custom_id, { ok: true, result });
        } else {
          // Błąd/wygaśnięcie pozycji nie jest płatne; zwalniamy rezerwację.
          this.guard.settle(entry.reserved, 0);
          const reason =
            line.result.type === 'errored'
              ? `błąd API: ${JSON.stringify(line.result.error).slice(0, 200)}`
              : `pozycja ${line.result.type}`;
          results.set(line.custom_id, { ok: false, error: reason });
        }
      }
    } catch (error) {
      // Błąd paczki nie wysadza serii: jej zadania kończą się błędem (do
      // ponowienia), a gotowe wyniki wcześniejszych paczek zostają.
      const message = error instanceof Error ? error.message : String(error);
      this.log(`paczka przerwana: ${message}`);
    } finally {
      // Pozycje bez rozliczenia: paczka nieprzyjęta nic nie kosztowała;
      // przyjęta, a urwana — liczymy rezerwację w całości (mogła kosztować,
      // lepiej zatrzymać serię za wcześnie niż za późno).
      for (const [id, entry] of byId) {
        if (settled.has(id)) continue;
        this.guard.settle(entry.reserved, created ? entry.reserved : 0);
        if (!results.has(id)) {
          results.set(id, { ok: false, error: 'paczka przerwana' });
        }
      }
    }
  }
}
