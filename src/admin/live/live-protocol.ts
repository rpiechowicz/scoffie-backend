import { LIVE_TOPICS, type LiveTopic } from '../../common/live-events';
import { roleHasPermission, type AdminPermission } from '../admin-permissions';
import type {
  LiveClientMessage,
  LiveTopic as ContractLiveTopic,
} from '../contract';

/**
 * Protokół kanału na żywo panelu: tematy → uprawnienia i walidacja
 * wiadomości od klienta. Czyste funkcje — testowane bez gniazd.
 */

// Szyna (`src/common/live-events.ts`) i kontrakt panelu (`contract.ts`) mają
// osobne kopie listy tematów; kompilator pilnuje, że są te same.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const TOPICS_IN_SYNC: Same<LiveTopic, ContractLiveTopic> = true;
void TOPICS_IN_SYNC;

/**
 * Uprawnienia, z których KAŻDE otwiera temat (`[]` = każda sesja — np.
 * własne sesje panelu). Sesja bez uprawnienia nie dostaje ani sygnałów, ani
 * powiadomień z tematu — tak samo, jak nie dostałaby danych z REST.
 */
export const LIVE_TOPIC_PERMISSIONS: Readonly<
  Record<LiveTopic, readonly AdminPermission[]>
> = {
  dashboard: ['dashboard.read'],
  users: ['users.read'],
  households: ['households.read'],
  assistant: ['assistant.read'],
  // Zgłoszenia leżą na ekranie asystenta (`GET /admin/assistant/reports`).
  reports: ['assistant.read'],
  subscriptions: ['subscriptions.read'],
  mail: ['mail.read'],
  alerts: ['alerts.read'],
  ops: ['ops.read'],
  audit: ['audit.read'],
  settings: ['settings.read', 'flags.read', 'announcements.read'],
  gdpr: ['gdpr.read'],
  'admin-sessions': [],
};

export function topicAllowed(role: string, topic: LiveTopic): boolean {
  const needed = LIVE_TOPIC_PERMISSIONS[topic];
  if (!needed) return false;
  return (
    needed.length === 0 ||
    needed.some((permission) => roleHasPermission(role, permission))
  );
}

export function topicsForRole(role: string): LiveTopic[] {
  return LIVE_TOPICS.filter((topic) => topicAllowed(role, topic));
}

/** Górna granica jednej wiadomości od klienta (bajty). */
export const LIVE_CLIENT_MAX_BYTES = 4 * 1024;

const SUBSCRIPTION_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Id Railwaya to UUID; zostawiamy zapas na inny format, ale bez znaków spoza. */
const RAILWAY_ID = /^[A-Za-z0-9-]{1,64}$/;

export type ParsedClientMessage =
  | { ok: true; message: LiveClientMessage }
  | { ok: false; code: 'BAD_MESSAGE' | 'TOO_LARGE'; message: string };

const bad = (message: string): ParsedClientMessage => ({
  ok: false,
  code: 'BAD_MESSAGE',
  message,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Wiadomość od klienta albo powód odrzucenia. Nieznane pola = błąd (jak
 * `forbidNonWhitelisted` w REST) — klient mówi tylko tym, co jest w kontrakcie.
 */
export function parseClientMessage(
  raw: string | Buffer,
  isBinary = false,
): ParsedClientMessage {
  const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length;
  if (size > LIVE_CLIENT_MAX_BYTES) {
    return {
      ok: false,
      code: 'TOO_LARGE',
      message: `Wiadomość większa niż ${LIVE_CLIENT_MAX_BYTES} B.`,
    };
  }
  if (isBinary) return bad('Tylko ramki tekstowe (JSON).');
  let value: unknown;
  try {
    value = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    return bad('To nie jest JSON.');
  }
  if (!isRecord(value) || typeof value.type !== 'string') {
    return bad('Brak pola `type`.');
  }
  const keys = Object.keys(value);
  const only = (...allowed: string[]) =>
    keys.every((key) => allowed.includes(key));

  switch (value.type) {
    case 'ping':
      return only('type')
        ? { ok: true, message: { type: 'ping' } }
        : bad('Nieznane pola w `ping`.');
    case 'logs.unsubscribe':
      if (!only('type', 'subscriptionId')) {
        return bad('Nieznane pola w `logs.unsubscribe`.');
      }
      if (
        typeof value.subscriptionId !== 'string' ||
        !SUBSCRIPTION_ID.test(value.subscriptionId)
      ) {
        return bad('Zły `subscriptionId`.');
      }
      return {
        ok: true,
        message: {
          type: 'logs.unsubscribe',
          subscriptionId: value.subscriptionId,
        },
      };
    case 'logs.subscribe': {
      if (
        !only('type', 'subscriptionId', 'serviceId', 'deploymentId', 'kind')
      ) {
        return bad('Nieznane pola w `logs.subscribe`.');
      }
      const { subscriptionId, serviceId, deploymentId, kind } = value;
      if (
        typeof subscriptionId !== 'string' ||
        !SUBSCRIPTION_ID.test(subscriptionId)
      ) {
        return bad('Zły `subscriptionId`.');
      }
      if (typeof serviceId !== 'string' || !RAILWAY_ID.test(serviceId)) {
        return bad('Zły `serviceId`.');
      }
      if (
        deploymentId !== undefined &&
        deploymentId !== null &&
        (typeof deploymentId !== 'string' || !RAILWAY_ID.test(deploymentId))
      ) {
        return bad('Zły `deploymentId`.');
      }
      if (kind !== 'deploy' && kind !== 'build') {
        return bad('`kind` to `deploy` albo `build`.');
      }
      return {
        ok: true,
        message: {
          type: 'logs.subscribe',
          subscriptionId,
          serviceId,
          ...(typeof deploymentId === 'string' ? { deploymentId } : {}),
          kind,
        },
      };
    }
    default:
      return bad('Nieznany typ wiadomości.');
  }
}

/**
 * Łączenie sygnałów `invalidate` jednego połączenia: pierwszy temat otwiera
 * okno (`delayMs`), kolejne się do niego dopisują, a po oknie idzie JEDNA
 * wiadomość z sumą tematów. Seria stu zdarzeń w sekundę = jedna ramka i jedno
 * odświeżenie w panelu; opóźnienie pojedynczego sygnału ≤ `delayMs`.
 */
export class InvalidateBatcher {
  private readonly pending = new Set<LiveTopic>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly flush: (topics: LiveTopic[]) => void,
    private readonly delayMs = 1_000,
  ) {}

  add(topics: readonly LiveTopic[]): void {
    for (const topic of topics) this.pending.add(topic);
    if (this.pending.size === 0 || this.timer) return;
    this.timer = setTimeout(() => this.fire(), this.delayMs);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }

  private fire(): void {
    this.timer = null;
    if (this.pending.size === 0) return;
    const topics = LIVE_TOPICS.filter((topic) => this.pending.has(topic));
    this.pending.clear();
    this.flush(topics);
  }
}
