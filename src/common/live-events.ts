import { Logger } from '@nestjs/common';

/**
 * Neutralna szyna zdarzeń „coś się zmieniło” dla kanału na żywo panelu
 * administratora (`src/admin/live/`).
 *
 * DLACZEGO TUTAJ. Moduł panelu jest jednokierunkowy — domena nie importuje
 * `src/admin/` (pilnuje `no-restricted-imports`). Domena woła więc tylko
 * `emitLive(...)` z tego pliku, a panel nasłuchuje przez `liveEvents.on`.
 * Bez panelu (albo z `ADMIN_LIVE=false`) nikt nie słucha i emisja kosztuje
 * jedno sprawdzenie pustej listy.
 *
 * GWARANCJE. `emitLive` nigdy nie rzuca i nie blokuje wołającego: słuchacze
 * biegną w `setImmediate`, po bieżącej odpowiedzi, każdy w osobnym
 * `try/catch`. Zdarzenie niesie TYLKO tematy i krótkie powiadomienie — bez
 * adresów e-mail i danych o zdrowiu; to, co panel ma pokazać, i tak pobierze
 * REST-em ze swoimi uprawnieniami.
 *
 * Singleton modułu, jak `disconnectRevokedUser` (`ws-rooms.ts`): serwisy
 * domeny nie dostają nowego parametru konstruktora (dziesiątki testów budują
 * je ręcznie), a skrypty CLI (np. `accounts:delete`) emitują w próżnię.
 */

/** Kopia `LiveTopic` z `src/admin/contract.ts` — trzymać w zgodzie. */
export const LIVE_TOPICS = [
  'dashboard',
  'users',
  'households',
  'assistant',
  'reports',
  'subscriptions',
  'mail',
  'alerts',
  'ops',
  'audit',
  'settings',
  'gdpr',
  'admin-sessions',
] as const;
export type LiveTopic = (typeof LIVE_TOPICS)[number];

export type LiveNoticeLevel = 'info' | 'success' | 'warning' | 'error';

export type LiveNotice = {
  level: LiveNoticeLevel;
  title: string;
  body?: string;
  link?: string;
  topic?: LiveTopic;
};

export type LiveEvent = {
  topics: LiveTopic[];
  notice?: LiveNotice;
  /** Tylko połączenia tego admina (np. jego własne sesje panelu). */
  adminUserId?: string;
  /** Bez połączeń tej sesji panelu (powiadomienie „dla innych sesji”). */
  exceptAdminSessionId?: string;
  /** Sesja panelu odwołana — jej kanały zamykają się natychmiast. */
  revokedAdminSessionId?: string;
};

export type LiveListener = (event: LiveEvent) => void;

export const LIVE_NOTICE_TITLE_MAX = 120;
export const LIVE_NOTICE_BODY_MAX = 300;

const clip = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

export class LiveEvents {
  private readonly logger = new Logger('LiveEvents');
  private readonly listeners = new Set<LiveListener>();

  /** Rejestruje słuchacza; zwraca funkcję wyrejestrowania. */
  on(listener: LiveListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  emit(event: LiveEvent): void {
    try {
      if (this.listeners.size === 0) return;
      const normalized = normalize(event);
      if (!normalized) return;
      const listeners = [...this.listeners];
      setImmediate(() => {
        for (const listener of listeners) {
          try {
            listener(normalized);
          } catch (error) {
            this.logger.warn(
              `listener failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      });
    } catch {
      // Szyna jest dodatkiem — nic, co się tu stanie, nie może położyć żądania.
    }
  }
}

function normalize(event: LiveEvent): LiveEvent | null {
  const topics = [
    ...new Set(
      (event.topics ?? []).filter((topic) =>
        (LIVE_TOPICS as readonly string[]).includes(topic),
      ),
    ),
  ];
  const notice = event.notice
    ? {
        ...event.notice,
        title: clip(String(event.notice.title ?? ''), LIVE_NOTICE_TITLE_MAX),
        ...(event.notice.body !== undefined
          ? { body: clip(String(event.notice.body), LIVE_NOTICE_BODY_MAX) }
          : {}),
      }
    : undefined;
  if (topics.length === 0 && !notice && !event.revokedAdminSessionId) {
    return null;
  }
  return { ...event, topics, ...(notice ? { notice } : {}) };
}

/** Jedna szyna na proces — ta sama instancja w DI (`CommonModule`). */
export const liveEvents = new LiveEvents();

/** Punkt emisji dla domeny. Nigdy nie rzuca. */
export function emitLive(event: LiveEvent): void {
  liveEvents.emit(event);
}
