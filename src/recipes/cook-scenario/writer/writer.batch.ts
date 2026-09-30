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

/**
 * Paczka w trakcie wysyłania — zapisana w dzienniku PRZED `create` (review
 * Codexa): gdy odpowiedź API zginie albo proces padnie przed zapisem id,
 * wznowienie szuka u dostawcy paczki z tymi pozycjami, zamiast wysyłać
 * i płacić drugi raz.
 */
export interface PendingSubmission {
  ids: string[];
  reservedMicroUsd: number;
  /** Chwila tuż przed `create` (ISO) — okno wyszukiwania paczki. */
  at: string;
}

export type ReconcileResult =
  | { kind: 'found'; batch: InflightBatch }
  | { kind: 'absent' }
  | { kind: 'wait'; until: string };

export interface BatchRunResult {
  results: Map<string, BatchCallResult>;
  /** Przyjęte, a nieodebrane (błąd sieci) — do odebrania przy wznowieniu. */
  interrupted: InflightBatch[];
  /** Wysyłka o nieznanym wyniku (błąd `create`) — do wyjaśnienia przy wznowieniu. */
  pending?: PendingSubmission;
  /** Dlaczego przebieg staje; `null` = całość. */
  stopReason: 'budget' | 'transport' | 'journal' | 'account' | null;
}

/**
 * Punkty zaczepienia dziennika w trakcie `run` (review Codexa):
 * - `onSubmitted` — paczka przyjęta; zapis id do dziennika (błąd zapisu
 *   NIE przerywa odbioru — paczka jest opłacona, odbieramy ją i tak);
 * - `onCollected` — paczka odebrana i rozliczona; jej wyniki trafiają do
 *   zadań i znika z „w locie” jednym zapisem dziennika, ZANIM pójdzie
 *   następna paczka rundy (nic nie liczy się podwójnie po restarcie);
 * - `canSubmit` — `false` = nie wysyłaj kolejnych paczek (dziennik nie
 *   działa — nowe paczki byłyby nieśledzone).
 */
export interface BatchHooks {
  /** Przed `create`; musi się udać (inaczej paczka nie idzie). */
  onSubmitting?: (pending: PendingSubmission) => Promise<void>;
  onSubmitted?: (batch: InflightBatch) => Promise<void>;
  onCollected?: (
    batch: InflightBatch,
    results: Map<string, BatchCallResult>,
  ) => Promise<void>;
  canSubmit?: () => boolean;
}

export interface BatchModel {
  run(calls: BatchCall[], hooks?: BatchHooks): Promise<BatchRunResult>;
  /** Odbiór wyników paczki wysłanej wcześniej (wznowienie). */
  collect(batch: InflightBatch, calls: BatchCall[]): Promise<BatchRunResult>;
  /**
   * Wysyłka o nieznanym wyniku: paczka z tymi pozycjami u dostawcy
   * (`found`), pewność, że jej nie przyjęto (`absent` — po oknie
   * widoczności), albo „jeszcze za wcześnie, by rozstrzygnąć” (`wait`).
   */
  reconcile(pending: PendingSubmission): Promise<ReconcileResult>;
}

/**
 * Id pozycji: przepis bez myślników + runda + znacznik SERII — ta sama
 * pozycja z innej serii (np. wcześniejszego testu) nigdy nie pomyli się
 * przy wyszukiwaniu paczki o nieznanym wyniku. Mieści się w 64 znakach.
 */
/**
 * Ile po zapowiedzi paczki czekamy, zanim „nie ma jej na liście” uznamy za
 * „nie przyjęto” (review Codexa: lista dostawcy może się spóźniać).
 */
export const VISIBILITY_WINDOW_MS = 20 * 60_000;

export const batchCallId = (recipeId: string, round: number, runId = '') =>
  `${recipeId.replace(/-/g, '')}-r${round}${runId ? `-${runId}` : ''}`;

export class BatchStoppedError extends Error {
  constructor(
    readonly reason:
      | 'budget'
      | 'transport'
      | 'save'
      | 'incomplete'
      | 'journal'
      | 'account'
      | 'gate',
    detail?: string,
  ) {
    super(
      {
        budget: 'budżet wyczerpany — doładuj i wznów (--resume)',
        account:
          'API odmówiło całej paczki (środki na koncie, limit albo klucz) — sprawdź konto Anthropic i wznów (--resume)',
        gate: 'bramka jakości zatrzymała serię — przejrzyj wyniki; wznowienie (--resume) z tą samą bramką znów stanie',
        journal:
          'dziennik nie daje się zapisać — przebieg stanął po odebraniu wysłanych paczek; napraw dysk i wznów (--resume)',
        save: 'nie wszystkie gotowe wyniki są zapisane w bazie — sprawdź bazę i wznów (--resume)',
        incomplete:
          'część przepisów bez wyniku po ponowieniach (błędy API) — wznów (--resume), dostaną nową serię prób',
        transport: 'przerwa w komunikacji z Batch API — wznów (--resume)',
      }[reason] + (detail ? ` (${detail})` : ''),
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
  /** Wysyłka o nieznanym wyniku (patrz `PendingSubmission`). */
  submitting: PendingSubmission | null;
  /** Znacznik serii w id pozycji. */
  runId: string;
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
  resume?: Pick<BatchJournal, 'round' | 'handled' | 'inflight'> &
    Partial<Pick<BatchJournal, 'submitting' | 'runId'>>;
  /** Znacznik nowej serii (przy wznowieniu bierzemy z dziennika). */
  runId?: string;
  /** Ile razy próbować zapisu jednego przepisu. */
  saveAttempts?: number;
  /**
   * Bramka jakości po każdej rundzie (review Codexa, noc 30.09): powód
   * zatrzymania albo `null`. Seria staje z pełnym dziennikiem, zanim
   * systemowy problem zdąży kosztować cały katalog.
   */
  gate?: () => string | null;
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
  let submitting: PendingSubmission | null = options.resume?.submitting ?? null;
  const runId = options.resume?.runId ?? options.runId ?? '';
  let round = options.resume?.round ?? 0;

  // Dziennik: zapis z ponowieniem; trwały błąd nie przerywa odbioru paczek
  // już opłaconych, ale wstrzymuje wysyłkę nowych (`canSubmit`).
  let journalBroken = false;
  const persist = async (): Promise<boolean> => {
    if (!options.persist) return true;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await options.persist({
          version: 1,
          round,
          spentMicroUsd: options.spentMicroUsd?.() ?? 0,
          handled: [...handled],
          inflight,
          submitting,
          runId,
          jobs: jobs.map((job) => job.snapshot()),
        });
        journalBroken = false;
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`dziennik: zapis nieudany (${attempt}/3): ${message}`);
        if (attempt < 3) await sleep(1000 * attempt);
      }
    }
    journalBroken = true;
    return false;
  };

  const callsOf = (forRound: number) =>
    jobs.flatMap((job) => {
      const call = job.nextCall();
      return call
        ? [{ job, call, id: batchCallId(job.recipe.id, forRound, runId) }]
        : [];
    });

  // Każda pozycja trafia do zadania najwyżej raz (wyniki przychodzą paczka
  // po paczce przez `onCollected`).
  const applied = new Set<string>();
  const apply = (
    pending: { job: ScenarioJob; id: string }[],
    results: Map<string, BatchCallResult>,
  ) => {
    for (const { job, id } of pending) {
      const outcome = results.get(id);
      if (!outcome || applied.has(id)) continue; // niewysłane / w locie
      applied.add(id);
      if (outcome.ok) job.accept(outcome.result);
      else job.transportFailure(outcome.error);
    }
  };

  // Zapisy po zastosowaniu WSZYSTKICH wyników; każdy przepis osobno.
  const saveDone = async () => {
    const attempts = options.saveAttempts ?? 3;
    for (const job of jobs) {
      // Zapisujemy tylko WYNIKI; zadanie nieudane (błędy API) nie jest
      // „obsłużone” — przebieg skończy się jako niekompletny.
      if (!job.done || job.failure || handled.has(job.jobId)) continue;
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

  // Wznowienie: nieudane zadania dostają nową serię prób…
  if (options.resume) {
    for (const job of jobs) job.resetFailure();
  }
  // Wysyłka o nieznanym wyniku: szukamy paczki u dostawcy, zanim cokolwiek
  // pójdzie drugi raz.
  if (submitting) {
    log(
      `wyjaśniam wysyłkę z ${submitting.at} (${submitting.ids.length} pozycji)`,
    );
    const found = await model.reconcile(submitting);
    if (found.kind === 'wait') {
      // Paczka mogła zostać przyjęta, a jeszcze nie być widoczna na liście —
      // do końca okna widoczności NIE wysyłamy niczego ponownie.
      log(`za wcześnie, by rozstrzygnąć — wznów po ${found.until}`);
      await persist();
      throw new BatchStoppedError('transport');
    }
    if (found.kind === 'found') {
      log(`paczka ${found.batch.batchId} jednak przyjęta — odbieram ją`);
      inflight.push(found.batch);
    } else {
      log('paczki nie przyjęto — pozycje pójdą ponownie');
    }
    submitting = null;
    await persist();
  }
  // …a najpierw odbiór paczek opłaconych przed przerwą.
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
      if (outcome.interrupted.length) {
        still.push(...outcome.interrupted);
      } else {
        inflight = inflight.filter((b) => b.batchId !== batch.batchId);
        await persist();
      }
    }
    inflight = still;
    await saveDone();
    if (inflight.length) throw new BatchStoppedError('transport');
  }

  // Zadania gotowe, a niezapisane (np. baza padła przed przerwą).
  await saveDone();

  for (;;) {
    const pending = callsOf(round + 1);
    if (!pending.length) {
      // Sukces tylko wtedy, gdy KAŻDY gotowy wynik jest w bazie (review
      // Codexa) — inaczej opłacony, a niezapisany wynik zniknąłby z oczu.
      if (jobs.some((job) => job.hasResult && !handled.has(job.jobId))) {
        throw new BatchStoppedError('save');
      }
      if (jobs.some((job) => job.failure)) {
        throw new BatchStoppedError('incomplete');
      }
      return;
    }
    round += 1;
    log(`runda ${round}: ${pending.length} wywołań`);
    const outcome = await model.run(
      pending.map(({ id, call }) => ({ id, call })),
      {
        onSubmitting: async (pending) => {
          submitting = pending;
          if (!(await persist())) {
            submitting = null;
            throw new Error('dziennik nie przyjął zapowiedzi paczki');
          }
        },
        onSubmitted: async (batch) => {
          submitting = null;
          inflight.push(batch);
          await persist();
        },
        onCollected: async (batch, results) => {
          // Odebrana (albo odrzucona przez API) — zapowiedź nieaktualna.
          submitting = null;
          apply(pending, results);
          inflight = inflight.filter((b) => b.batchId !== batch.batchId);
          await persist();
        },
        canSubmit: () => !journalBroken,
      },
    );
    apply(pending, outcome.results);
    inflight = outcome.interrupted;
    // Błąd `create` = wynik nieznany — zapowiedź zostaje w dzienniku.
    submitting = outcome.pending ?? null;
    await saveDone();
    if (outcome.stopReason) throw new BatchStoppedError(outcome.stopReason);
    if (journalBroken) throw new BatchStoppedError('journal');
    // Bramka ma sens tylko, gdy jest jeszcze co wydać — po ostatniej rundzie
    // zatrzymanie oznaczałoby skończoną serię jako przerwaną.
    const gate = jobs.some((job) => !job.done)
      ? (options.gate?.() ?? null)
      : null;
    if (gate) {
      log(`bramka jakości: ${gate}`);
      throw new BatchStoppedError('gate', gate);
    }
  }
}

export interface AnthropicBatchOptions {
  /** Co ile sekund pytać o stan paczki. */
  pollSeconds?: number;
  now?: () => number;
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
  private readonly now: () => number;

  constructor(
    private readonly client: Anthropic,
    private readonly guard: BudgetGuard,
    private readonly log: (line: string) => void = () => undefined,
    options: AnthropicBatchOptions = {},
  ) {
    this.pollMs = (options.pollSeconds ?? 30) * 1000;
    this.retries = options.retries ?? 8;
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async run(
    calls: BatchCall[],
    hooks: BatchHooks = {},
  ): Promise<BatchRunResult> {
    const results = new Map<string, BatchCallResult>();
    let queue = [...calls];
    while (queue.length) {
      if (hooks.canSubmit && !hooks.canSubmit()) {
        // Dziennik nie działa — nowej paczki nie wysyłamy (byłaby nieśledzona).
        return { results, interrupted: [], stopReason: null };
      }
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
      const pending: PendingSubmission = {
        ids: chunk.map((e) => e.item.id),
        reservedMicroUsd: reservedTotal,
        at: new Date(this.now()).toISOString(),
      };
      // Zapowiedź w dzienniku PRZED wysyłką — bez niej paczka nie idzie.
      try {
        await hooks.onSubmitting?.(pending);
      } catch (error) {
        for (const entry of chunk) this.guard.settle(entry.reserved, 0);
        this.log(`paczka niewysłana (dziennik): ${messageOf(error)}`);
        return { results, interrupted: [], stopReason: 'journal' };
      }
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
        if (isAccountRefusal(error)) {
          // Odmowa KONTA (brak środków, limit, klucz) dotyczy każdej paczki,
          // nie tych pozycji — cała seria staje, zadania bez nowych błędów
          // (review Codexa, noc 30.09: wcześniej każde zadanie dostawało
          // trzy „błędy API” i seria kończyła się jako niekompletna).
          for (const entry of chunk) this.guard.settle(entry.reserved, 0);
          this.log(`API odmówiło paczki (konto): ${messageOf(error)}`);
          await hooks.onCollected?.(
            { batchId: 'odrzucona', ids: pending.ids, reservedMicroUsd: 0 },
            new Map(),
          );
          return { results, interrupted: [], stopReason: 'account' };
        }
        if (isDefinitiveRejection(error)) {
          // API ODPOWIEDZIAŁO odmową (4xx: zły żądanie, limit, uprawnienia) —
          // paczki na pewno nie ma. Rezerwacja wraca, pozycje dostają błąd
          // (zadania ponowią w następnej rundzie, najwyżej 3 razy) — bez
          // 20-minutowego czekania na wynik, który nie istnieje (review Codexa).
          for (const entry of chunk) this.guard.settle(entry.reserved, 0);
          const message = `API odrzuciło paczkę: ${messageOf(error)}`;
          this.log(message);
          const rejected = new Map<string, BatchCallResult>(
            chunk.map((entry) => [
              entry.item.id,
              { ok: false, error: message } as const,
            ]),
          );
          for (const [id, value] of rejected) results.set(id, value);
          await hooks.onCollected?.(
            { batchId: 'odrzucona', ids: pending.ids, reservedMicroUsd: 0 },
            rejected,
          );
          queue = rest;
          continue;
        }
        // Wynik NIEZNANY: API mogło paczkę przyjąć, a odpowiedź zginąć.
        // Rezerwacja zostaje, zapowiedź w dzienniku — wznowienie sprawdzi
        // u dostawcy, zanim wyśle cokolwiek ponownie.
        this.log(`wysyłka paczki bez odpowiedzi: ${messageOf(error)}`);
        return { results, interrupted: [], pending, stopReason: 'transport' };
      }
      const inflight: InflightBatch = {
        batchId,
        ids: chunk.map((e) => e.item.id),
        reservedMicroUsd: reservedTotal,
      };
      this.log(`paczka ${batchId}: ${chunk.length} pozycji wysłana`);
      // Paczka JUŻ przyjęta i opłacona — błąd dziennika nie może jej porzucić.
      try {
        await hooks.onSubmitted?.(inflight);
      } catch (error) {
        this.log(
          `UWAGA: paczka ${batchId} bez wpisu w dzienniku: ${messageOf(error)}`,
        );
      }
      const received = new Map<string, BatchCallResult>();
      const collected = await this.receive(inflight, chunk, received);
      for (const [id, value] of received) results.set(id, value);
      if (!collected) {
        return { results, interrupted: [inflight], stopReason: 'transport' };
      }
      try {
        await hooks.onCollected?.(inflight, received);
      } catch (error) {
        this.log(`dziennik po odbiorze ${batchId}: ${messageOf(error)}`);
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

  /**
   * Szuka paczki z pozycjami zapowiedzi: wśród paczek utworzonych w oknie
   * wokół `at` (±5 min przed, do 20 min po) z tą samą liczbą pozycji —
   * i sprawdza ich `custom_id` (id z `runId` serii, więc jednoznaczne).
   * Paczkę w toku trzeba doczekać: pozycje są widoczne dopiero w wynikach.
   */
  async reconcile(pending: PendingSubmission): Promise<ReconcileResult> {
    const at = Date.parse(pending.at);
    const from = at - 5 * 60_000;
    // Okno widoczności: do tej chwili przyjęta paczka mogła się jeszcze nie
    // pojawić na liście — wcześniej „nie ma” nie znaczy „nie przyjęto”.
    const until = at + VISIBILITY_WINDOW_MS;
    const wanted = new Set(pending.ids);
    // Najpóźniejsze wygaśnięcie pasującej paczki w toku — do tej chwili
    // czekamy (świadomy wybór: bez znacznika paczki u dostawcy nie odróżnimy
    // naszej w toku od obcej; czekanie grozi opóźnieniem, a zgadywanie —
    // podwójną płatnością; paczki z tego konta wysyła tylko ten skrypt).
    let undecidedUntil = 0;
    for await (const batch of this.client.messages.batches.list({
      limit: 100,
    })) {
      const created = Date.parse(batch.created_at);
      if (created < from) break; // lista od najnowszych
      if (created > until) continue;
      const c = batch.request_counts;
      const total =
        c.processing + c.succeeded + c.errored + c.canceled + c.expired;
      if (total !== pending.ids.length) continue;
      // Paczka w toku: jej pozycji nie da się jeszcze sprawdzić — NIE czekamy
      // na nią (może być obca i trwać do 24 h, review Codexa); zapamiętujemy
      // i najwyżej odpowiadamy „za wcześnie”.
      if (batch.processing_status !== 'ended') {
        undecidedUntil = Math.max(
          undecidedUntil,
          Date.parse(batch.expires_at ?? '') || created + 24 * 3_600_000,
        );
        continue;
      }
      const lines = await this.retry(() =>
        this.client.messages.batches.results(batch.id),
      );
      // Paczka „nasza” tylko przy DOKŁADNIE tym samym zbiorze pozycji.
      const seen = new Set<string>();
      let foreign = false;
      for await (const line of lines) {
        if (!wanted.has(line.custom_id)) {
          foreign = true;
          break;
        }
        seen.add(line.custom_id);
      }
      if (!foreign && seen.size === wanted.size) {
        return {
          kind: 'found',
          batch: {
            batchId: batch.id,
            ids: pending.ids,
            reservedMicroUsd: pending.reservedMicroUsd,
          },
        };
      }
    }
    // Nierozstrzygnięte (pasująca paczka jeszcze w toku) albo okno widoczności
    // trwa — czekamy; dopiero potem „nie przyjęto”.
    const waitUntil = Math.max(until, undecidedUntil);
    if (this.now() < waitUntil) {
      return { kind: 'wait', until: new Date(waitUntil).toISOString() };
    }
    return { kind: 'absent' };
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
      // Przyjęta, a nieodebrana: pieniądze mogły pójść — rezerwacja ZOSTAJE
      // (nierozliczona), więc ten proces nie wyda ponad limit, a w dzienniku
      // żyje osobno jako `inflight.reservedMicroUsd`. Rozliczone
      // (`spentMicroUsd`) nigdy jej nie zawiera — jedna, jednoznaczna
      // semantyka niezależnie od tego, czy proces padł, czy odbiór się urwał
      // (review Codexa).
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

/**
 * Odmowa dotycząca KONTA, nie treści: 401/403 (klucz, uprawnienia), 402,
 * 429 (limit) albo komunikat o środkach — ponawianie pozycji nic nie da.
 */
export function isAccountRefusal(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 401 || status === 402 || status === 403 || status === 429) {
    return true;
  }
  return (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    /credit balance|billing|insufficient|quota/i.test(messageOf(error))
  );
}

/**
 * Odmowa z odpowiedzią HTTP 4xx = paczki na pewno nie przyjęto. Brak
 * odpowiedzi (sieć, limit czasu) i 5xx — wynik nieznany.
 */
function isDefinitiveRejection(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
