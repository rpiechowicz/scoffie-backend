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
import type { RailwayData, RailwayService } from '../contract';
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

/** Usługa w ostatnim znanym stanie — tyle, ile potrzeba licznikom panelu. */
export type KnownService = Pick<
  RailwayService,
  'id' | 'name' | 'cron' | 'runs' | 'deploys'
>;

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
  /** Ostatni pełny odczyt Railwaya (ekran „System”, przebieg alertów) i chwila pobrania. */
  private snapshot: { data: RailwayData; at: number } | null = null;
  /** Ostatnie najnowsze wdrożenia z własnego odczytu albo `observe`. */
  private latest: { list: LatestDeploy[]; at: number } | null = null;

  /**
   * Pełny odczyt Railwaya z innego miejsca — pamiętany dla liczników panelu
   * (`GET /admin/badges`), żeby te nigdy nie pytały Railwaya. `at` — chwila
   * pobrania (odczyt z pamięci na minutę ma starszą niż teraz); starszy od
   * zapamiętanego nie nadpisuje.
   */
  remember(data: RailwayData, at: number = this.io.now()): void {
    if (this.snapshot && this.snapshot.at > at) return;
    this.snapshot = { data, at };
  }

  /** Ostatni pełny odczyt Railwaya i chwila pobrania — zasiewa pamięć ekranu „System”. */
  fullSnapshot(): { data: RailwayData; at: number } | null {
    return this.snapshot;
  }

  /**
   * Ostatni znany stan usług bez pytania Railwaya: pełny odczyt z nałożonymi
   * świeższymi wdrożeniami ze śledzenia. `null` — jeszcze nic (tuż po
   * starcie procesu, zanim cokolwiek zapytało Railway).
   */
  lastKnown(): KnownService[] | null {
    const latest = this.latest;
    const snapshot = this.snapshot;
    if (!snapshot) {
      if (!latest) return null;
      // Tylko śledzenie: bez historii cronów — liczy się samo wdrożenie.
      return latest.list.map((s) => ({
        id: s.serviceId,
        name: s.serviceName,
        cron: null,
        runs: [],
        deploys: s.deploy ? [s.deploy] : [],
      }));
    }
    const fresher =
      latest && latest.at >= snapshot.at
        ? new Map(latest.list.map((s) => [s.serviceId, s.deploy]))
        : null;
    return snapshot.data.services.map((s) => {
      const deploy = fresher?.get(s.id);
      if (!deploy) return s;
      const rest =
        s.deploys[0]?.id === deploy.id ? s.deploys.slice(1) : s.deploys;
      return { ...s, deploys: [deploy, ...rest] };
    });
  }

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
    this.latest = { list, at: this.io.now() };
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
