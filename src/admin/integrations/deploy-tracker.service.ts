import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  emitLive,
  type LiveEvent,
  type LiveNotice,
} from '../../common/live-events';
import type { RailwayData } from '../contract';
import { IntegrationError } from './integration-fetch';
import { readRailwayToken } from './integrations-env';
import {
  fetchLatestDeploys,
  railwayGql,
  railwayScope,
  type LatestDeploy,
  type RailwayScope,
} from './railway.client';

/** Stany Railwaya, w których wdrożenie jeszcze trwa albo czeka. */
const IN_PROGRESS = new Set([
  'QUEUED',
  'WAITING',
  'INITIALIZING',
  'BUILDING',
  'DEPLOYING',
  'NEEDS_APPROVAL',
]);
export const deployInProgress = (status: string | null | undefined): boolean =>
  !!status && IN_PROGRESS.has(status);

/** Zakończenia, o których panel dostaje powiadomienie. */
const FINISHED: Record<string, { level: LiveNotice['level']; text: string }> = {
  SUCCESS: { level: 'success', text: 'wdrożenie udane' },
  FAILED: { level: 'error', text: 'wdrożenie nieudane' },
  CRASHED: { level: 'error', text: 'usługa padła po wdrożeniu' },
};

/** Najczęściej co tyle — webhook przy jednym wdrożeniu przychodzi kilka razy. */
export const MIN_GAP_MS = 3_000;
/** Kolejne sprawdzenie, póki coś się buduje albo wdraża. */
export const FOLLOW_MS = 8_000;
/** Dłużej nie śledzimy jednej serii — zawieszona budowa nie może pytać w nieskończoność. */
export const MAX_TRACK_MS = 30 * 60_000;
/** Projekt i lista usług zmieniają się rzadko — nie pytamy o nie co 8 s. */
const SCOPE_TTL_MS = 10 * 60_000;

type Known = Map<string, { deployId: string | null; status: string | null }>;

/** Najnowsze wdrożenia z pełnego odczytu (`fetchRailway`). */
export const latestOf = (data: RailwayData): LatestDeploy[] =>
  data.services.map((s) => ({
    serviceId: s.id,
    serviceName: s.name,
    deploy: s.deploys[0] ?? null,
  }));

const knownOf = (list: LatestDeploy[]): Known =>
  new Map(
    list.map((s) => [
      s.serviceId,
      { deployId: s.deploy?.id ?? null, status: s.deploy?.status ?? null },
    ]),
  );

const sameKnown = (a: Known, b: Known): boolean =>
  a.size === b.size &&
  [...a].every(([id, x]) => {
    const y = b.get(id);
    return !!y && y.deployId === x.deployId && y.status === x.status;
  });

/**
 * Wdrożenia, które od poprzedniego odczytu przeszły z „w toku” do wyniku.
 * Tylko te widziane w toku — stare wyniki po restarcie nie dzwonią.
 */
export function finishedNotices(
  prev: Known,
  list: LatestDeploy[],
): LiveNotice[] {
  const notices: LiveNotice[] = [];
  for (const s of list) {
    const before = prev.get(s.serviceId);
    const d = s.deploy;
    const outcome = d ? FINISHED[d.status] : undefined;
    if (!d || !outcome || !before || before.deployId !== d.id) continue;
    if (!deployInProgress(before.status)) continue;
    const commit = d.commitMessage?.split('\n')[0]?.trim();
    notices.push({
      level: outcome.level,
      title: `${s.serviceName} — ${outcome.text}`,
      ...(commit ? { body: commit } : {}),
      link: `/system/${s.serviceId}`,
      topic: 'ops',
    });
  }
  return notices;
}

export type DeployTrackerIo = {
  now(): number;
  /** `null` — Railway niepodłączony (brak tokenu). */
  load(): Promise<LatestDeploy[] | null>;
  emit(event: LiveEvent): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
};

/**
 * Wdrożenia Railway na żywo: po „szturchnięciu” (webhook Railwaya, otwarty
 * ekran „System” z wdrożeniem w toku, przebieg alertów) pyta Railway o
 * najnowsze wdrożenie każdej usługi. Zmiana stanu → sygnał `ops` do panelu
 * (i unieważnienie pamięci odczytu), zakończenie → powiadomienie. Póki coś
 * się buduje — kolejne pytanie za 8 s, najdłużej 30 min.
 *
 * Szturchnięcia się zlewają: najwyżej jedno pytanie naraz i nie częściej niż
 * co 3 s, więc seria webhooków przy jednym wdrożeniu to jedno-dwa pytania.
 * Nigdy nie rzuca. W testach (`NODE_ENV=test`) bez timerów — spec włącza je
 * wprost (`timers = true`) i podstawia `io`.
 */
@Injectable()
export class DeployTrackerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(DeployTrackerService.name);
  timers = process.env.NODE_ENV !== 'test';
  io: DeployTrackerIo = this.defaultIo();

  private timer: unknown = null;
  private timerAt = 0;
  private running: Promise<void> | null = null;
  private again = false;
  private lastRunAt = -Infinity;
  private known: Known | null = null;
  private trackingSince: number | null = null;
  private readonly listeners = new Set<() => void>();
  private scope: { value: RailwayScope; at: number } | null = null;

  /** Przebieg z wynikiem innym niż poprzedni — np. czyszczenie pamięci odczytu. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onApplicationBootstrap(): void {
    // Po starcie (także po wdrożeniu samego backendu) — stan na teraz, żeby
    // pierwsza zmiana po nim już dała sygnał.
    if (this.timers && readRailwayToken()) this.schedule(10_000);
  }

  onModuleDestroy(): void {
    if (this.timer !== null) this.io.clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  /** „Coś się zmieniło w wdrożeniach” — sprawdź najszybciej, jak wolno. */
  poke(): void {
    this.schedule(Math.max(0, this.lastRunAt + MIN_GAP_MS - this.io.now()));
  }

  /** Świeży pełny odczyt z innego miejsca (przebieg alertów) — bez pytania Railwaya. */
  observe(list: LatestDeploy[]): void {
    try {
      this.apply(list);
    } catch (error) {
      this.warn(error);
    }
    this.follow();
  }

  /** Jedno pytanie do Railwaya; równoległe wywołania dostają to samo. */
  run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.lastRunAt = this.io.now();
    this.running = (async () => {
      try {
        const list = await this.io.load();
        if (list) this.apply(list);
      } catch (error) {
        this.scope = null;
        this.warn(error);
      } finally {
        this.running = null;
      }
      if (this.again) {
        this.again = false;
        this.poke();
      } else {
        this.follow();
      }
    })();
    return this.running;
  }

  private apply(list: LatestDeploy[]): void {
    const next = knownOf(list);
    const prev = this.known;
    this.known = next;
    const busy = list.some((s) => deployInProgress(s.deploy?.status));
    if (!busy) this.trackingSince = null;
    else this.trackingSince ??= this.io.now();

    // Pierwszy odczyt po starcie: sygnał tylko, gdy coś jest w toku — panel
    // po ponownym połączeniu i tak pobiera stan od nowa.
    const changed = prev === null ? busy : !sameKnown(prev, next);
    if (!changed) return;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.warn(error);
      }
    }
    const notices = prev ? finishedNotices(prev, list) : [];
    if (notices.length === 0) this.io.emit({ topics: ['ops'] });
    for (const notice of notices) this.io.emit({ topics: ['ops'], notice });
  }

  private follow(): void {
    if (this.trackingSince === null) return;
    if (this.io.now() - this.trackingSince >= MAX_TRACK_MS) {
      this.logger.warn('wdrożenie w toku dłużej niż 30 min — koniec śledzenia');
      this.trackingSince = null;
      return;
    }
    this.schedule(FOLLOW_MS);
  }

  private schedule(delay: number): void {
    if (!this.timers) return;
    if (this.running) {
      this.again = true;
      return;
    }
    const at = this.io.now() + delay;
    if (this.timer !== null) {
      if (this.timerAt <= at) return;
      this.io.clearTimeout(this.timer);
    }
    this.timerAt = at;
    this.timer = this.io.setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delay);
  }

  private warn(error: unknown): void {
    this.logger.warn(
      `śledzenie wdrożeń: ${
        error instanceof IntegrationError || error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }

  private defaultIo(): DeployTrackerIo {
    return {
      now: () => Date.now(),
      load: async () => {
        const token = readRailwayToken();
        if (!token) return null;
        const gql = railwayGql(token);
        const now = Date.now();
        if (!this.scope || now - this.scope.at >= SCOPE_TTL_MS) {
          this.scope = { value: await railwayScope(gql), at: now };
        }
        return fetchLatestDeploys(gql, this.scope.value);
      },
      emit: emitLive,
      setTimeout: (fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref();
        return t;
      },
      clearTimeout: (id) => clearTimeout(id as NodeJS.Timeout),
    };
  }
}
