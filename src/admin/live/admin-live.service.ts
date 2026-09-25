import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { randomUUID } from 'crypto';
import type { IncomingMessage, Server as HttpServer } from 'http';
import type { Duplex } from 'stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { AppException } from '../../common/app-exception';
import { LiveEvents, type LiveEvent } from '../../common/live-events';
import { readAdminEnv } from '../../config/admin-env';
import { AdminGate } from '../admin-gate';
import { roleHasPermission } from '../admin-permissions';
import { AdminRateLimiter } from '../admin-rate-limiter';
import type { AdminAccessContext, AdminRequest } from '../admin-request';
import {
  AdminSessionsService,
  stepUpValid,
  type ResolvedAdminSession,
} from '../auth/admin-sessions.service';
import type {
  LiveClientMessage,
  LiveErrorCode,
  LiveServerMessage,
} from '../contract';
import { IntegrationError } from '../integrations/integration-fetch';
import { readRailwayToken } from '../integrations/integrations-env';
import {
  fetchRailwayLogLinesSince,
  RailwayLogTail,
  resolveRailwayLogDeployment,
} from '../integrations/railway-service.client';
import {
  InvalidateBatcher,
  parseClientMessage,
  topicAllowed,
  topicsForRole,
} from './live-protocol';

/** Ścieżka kanału na backendzie (Worker panelu mapuje `/api/ws` → tu). */
export const ADMIN_LIVE_PATH = '/admin/ws';

export const LIVE_LIMITS = {
  /** jednoczesnych połączeń jednej sesji panelu (nadmiarowe: zamykane najstarsze) */
  connectionsPerSession: 5,
  /** prób otwarcia kanału na minutę z jednego adresu */
  upgradesPerMinutePerIp: 20,
  /** ponowna walidacja sesji */
  revalidateMs: 60_000,
  /** ping ramką WS; brak `pong` do następnego = martwe połączenie */
  heartbeatMs: 30_000,
  /** łączenie `invalidate` */
  invalidateDelayMs: 1_000,
  logs: {
    perConnection: 2,
    pollMs: 5_000,
    /** subskrypcja bez odświeżenia wygasa */
    ttlMs: 15 * 60_000,
    /** zakładka na spóźnione linie przy każdym pobraniu */
    overlapMs: 10_000,
    /** kolejnych porażek Railwaya, po których subskrypcja się kończy */
    maxFailures: 3,
    /** nowych subskrypcji na minutę na połączenie */
    subscribesPerMinute: 10,
  },
  /** złych wiadomości, po których połączenie jest zamykane */
  badMessages: 2,
  /** twardy limit na uwierzytelnienie przy upgrade */
  authTimeoutMs: 10_000,
} as const;

const CLOSE = {
  session: 4401,
  badMessages: 4400,
  tooMany: 4429,
  restart: 1012,
} as const;

/** Wyłącznik (`ADMIN_LIVE=false`) — czytany per upgrade. Domyślnie włączony. */
export function adminLiveEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (env.ADMIN_LIVE ?? '').trim().toLowerCase() !== 'false';
}

type LogSubscription = {
  id: string;
  serviceId: string;
  requestedDeploymentId: string | undefined;
  kind: 'deploy' | 'build';
  deploymentId: string | null;
  tail: RailwayLogTail;
  since: number;
  expiresAt: number;
  timer: NodeJS.Timeout | null;
  busy: boolean;
  failures: number;
  primed: boolean;
};

type Connection = {
  id: string;
  ws: WebSocket;
  /** Żądanie upgrade — nagłówki (JWT Access, ciasteczko) do ponownej walidacji. */
  req: AdminRequest;
  access: AdminAccessContext;
  sessionId: string;
  adminUserId: string;
  role: string;
  stepUpUntil: Date | null;
  stepUpNotified: boolean;
  openedAt: number;
  alive: boolean;
  badMessages: number;
  batcher: InvalidateBatcher;
  logs: Map<string, LogSubscription>;
  subscribeStamps: number[];
  closed: boolean;
};

/**
 * Kanał na żywo panelu administratora (`GET /admin/ws`, WebSocket).
 *
 * REST zostaje jedynym źródłem danych — tu płyną wyłącznie sygnały
 * „odśwież temat X” (`invalidate`), krótkie powiadomienia, stan sesji i
 * strumień logów Railway. Kontrakt wiadomości: sekcja „Kanał na żywo” w
 * `contract.ts`.
 *
 * PODPIĘCIE. Serwer `ws` w trybie `noServer`. Socket.IO aplikacji (engine.io)
 * rejestruje własny `upgrade` na serwerze HTTP i KAŻDĄ obcą ścieżkę niszczy po
 * `destroyUpgradeTimeout` (1 s), jeśli nic nie zostało zapisane — weryfikacja
 * JWT Access z pobraniem JWKS potrafi trwać dłużej. Dlatego po starcie
 * (`onApplicationBootstrap`, gdy gatewaye już są podpięte) przejmujemy
 * listę słuchaczy `upgrade`: ścieżki `/admin…` obsługujemy sami, WSZYSTKO
 * inne idzie do dotychczasowych słuchaczy bez zmian (ten sam `this`, te same
 * argumenty) — Socket.IO działa dokładnie jak wcześniej.
 *
 * BRAMKI przy upgrade, w kolejności REST-a: bramka Access (brak = 404),
 * limit prób z adresu (429), `Origin` z `ADMIN_WEBAUTHN_ORIGIN` (403 —
 * obrona przed cross-site WebSocket hijacking; ciasteczko `SameSite=Strict`
 * to druga linia), sesja panelu (brak / `mustReenroll` = 404). Odmowa to
 * czysta odpowiedź HTTP i zamknięcie gniazda. Po otwarciu: ponowna walidacja
 * co minutę BEZ przesuwania `lastSeenAt` (otwarta karta nie podtrzymuje
 * sesji), odwołanie sesji zamyka jej kanały od razu (szyna `LiveEvents`),
 * tematy filtrowane uprawnieniami roli.
 */
@Injectable()
export class AdminLiveService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AdminLiveService.name);
  private readonly wss = new WebSocketServer({
    noServer: true,
    // Twarda granica biblioteki (zamknięcie 1009); miękka — 4 KB z `error` —
    // jest w `parseClientMessage`.
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  });
  private readonly connections = new Set<Connection>();
  private server: HttpServer | null = null;
  private previousUpgrade: ((...args: unknown[]) => void)[] = [];
  private dispatcher: ((...args: unknown[]) => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  private revalidateTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly gate: AdminGate,
    private readonly sessions: AdminSessionsService,
    private readonly limiter: AdminRateLimiter,
    private readonly live: LiveEvents,
  ) {}

  onApplicationBootstrap(): void {
    const server = this.adapterHost.httpAdapter?.getHttpServer?.() as
      | HttpServer
      | undefined;
    if (!server || typeof server.listeners !== 'function') return;
    this.server = server;
    this.previousUpgrade = server.listeners('upgrade') as ((
      ...args: unknown[]
    ) => void)[];
    server.removeAllListeners('upgrade');
    this.dispatcher = (...args: unknown[]) => {
      const [req, socket, head] = args as [IncomingMessage, Duplex, Buffer];
      if (adminLiveEnabled() && isAdminPath(req.url)) {
        void this.handleUpgrade(req, socket, head);
        return;
      }
      if (this.previousUpgrade.length === 0) {
        // Zachowanie Node bez słuchaczy: zerwać połączenie.
        socket.destroy();
        return;
      }
      for (const listener of this.previousUpgrade) {
        listener.apply(server, args);
      }
    };
    server.on('upgrade', this.dispatcher);

    this.unsubscribe = this.live.on((event) => this.onEvent(event));
    this.revalidateTimer = setInterval(
      () => void this.revalidateAll(),
      LIVE_LIMITS.revalidateMs,
    );
    this.revalidateTimer.unref();
    this.heartbeatTimer = setInterval(
      () => this.heartbeat(),
      LIVE_LIMITS.heartbeatMs,
    );
    this.heartbeatTimer.unref();
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.revalidateTimer) clearInterval(this.revalidateTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const conn of [...this.connections]) {
      this.close(conn, CLOSE.restart, 'restart');
    }
    if (this.server && this.dispatcher) {
      this.server.removeListener('upgrade', this.dispatcher);
      for (const listener of this.previousUpgrade) {
        this.server.on('upgrade', listener);
      }
    }
    this.dispatcher = null;
    this.server = null;
    this.wss.close();
  }

  /** Liczba otwartych kanałów (testy, diagnostyka). */
  get connectionCount(): number {
    return this.connections.size;
  }

  // ——— upgrade ———

  private async handleUpgrade(
    rawReq: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    socket.on('error', () => undefined);
    const req = rawReq as AdminRequest;
    // `req.ip` Expressa (trust proxy = 1 hop) — tu go nie ma, bo Express nie
    // widzi upgrade; ta sama reguła: ostatni wpis `X-Forwarded-For`.
    Object.defineProperty(req, 'ip', {
      value: forwardedIp(rawReq),
      configurable: true,
      writable: true,
    });
    const timeout = setTimeout(() => {
      reject(socket, 503, 'SERVICE_UNAVAILABLE', 'Spróbuj ponownie.');
    }, LIVE_LIMITS.authTimeoutMs);
    timeout.unref();
    try {
      const outcome = await this.authorize(req);
      if (socket.destroyed || socket.writableEnded) return;
      if (!outcome.ok) {
        reject(socket, outcome.status, outcome.code, outcome.message, {
          url: rawReq.url ?? ADMIN_LIVE_PATH,
          retryAfter: outcome.retryAfter,
        });
        return;
      }
      clearTimeout(timeout);
      this.wss.handleUpgrade(rawReq, socket, head, (ws) =>
        this.attach(ws, req, outcome.access, outcome.session),
      );
    } catch (error) {
      this.logger.warn(
        `upgrade kanału panelu padł: ${error instanceof Error ? error.message : String(error)}`,
      );
      reject(socket, 503, 'SERVICE_UNAVAILABLE', 'Spróbuj ponownie.');
    } finally {
      clearTimeout(timeout);
    }
  }

  private async authorize(req: AdminRequest): Promise<
    | { ok: true; access: AdminAccessContext; session: ResolvedAdminSession }
    | {
        ok: false;
        status: number;
        code: string;
        message: string;
        retryAfter?: number;
      }
  > {
    const hidden = {
      ok: false as const,
      status: 404,
      code: 'NOT_FOUND',
      message: `Cannot GET ${req.url ?? ADMIN_LIVE_PATH}`,
    };
    const access = await this.gate.pass(req);
    if (!access) return hidden;
    // Inna ścieżka pod `/admin` z nagłówkiem Upgrade — to samo 404 co REST.
    if (pathname(req.url) !== ADMIN_LIVE_PATH) return hidden;

    try {
      this.limiter.check(
        `live:${access.ip ?? 'unknown'}`,
        LIVE_LIMITS.upgradesPerMinutePerIp,
      );
    } catch (error) {
      if (error instanceof AppException) {
        const detail = (error.details ?? []).find((d) =>
          d.startsWith('retryAfterSeconds:'),
        );
        return {
          ok: false,
          status: 429,
          code: 'TOO_MANY_REQUESTS',
          message: 'Za dużo żądań. Spróbuj ponownie za chwilę.',
          retryAfter: detail ? Number(detail.split(':')[1]) : 60,
        };
      }
      throw error;
    }

    const origin = (headerOf(req, 'origin') ?? '').replace(/\/+$/, '');
    if (!origin || !readAdminEnv().webauthnOrigins.includes(origin)) {
      return {
        ok: false,
        status: 403,
        code: 'CROSS_SITE',
        message: 'Żądanie spoza panelu.',
      };
    }

    const session = await this.sessions.resolve(req, access.email);
    if (!session || session.mustReenroll) return hidden;
    return { ok: true, access, session };
  }

  private attach(
    ws: WebSocket,
    req: AdminRequest,
    access: AdminAccessContext,
    session: ResolvedAdminSession,
  ): void {
    const conn: Connection = {
      id: randomUUID(),
      ws,
      req,
      access,
      sessionId: session.id,
      adminUserId: session.adminUserId,
      role: session.admin.role,
      stepUpUntil: session.stepUpUntil,
      stepUpNotified: !stepUpValid(session),
      openedAt: Date.now(),
      alive: true,
      badMessages: 0,
      batcher: new InvalidateBatcher(
        (topics) =>
          this.send(conn, {
            type: 'invalidate',
            topics,
            at: new Date().toISOString(),
          }),
        LIVE_LIMITS.invalidateDelayMs,
      ),
      logs: new Map(),
      subscribeStamps: [],
      closed: false,
    };

    // Limit na sesję: nadmiarowe połączenie wypiera NAJSTARSZE (zapomniana
    // karta), a nie odbija nowe — inaczej świeża karta nie miałaby kanału.
    const same = [...this.connections]
      .filter((c) => c.sessionId === conn.sessionId)
      .sort((a, b) => a.openedAt - b.openedAt);
    while (same.length >= LIVE_LIMITS.connectionsPerSession) {
      const oldest = same.shift();
      if (oldest) this.close(oldest, CLOSE.tooMany, 'too many connections');
    }

    this.connections.add(conn);
    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('message', (data: RawData, isBinary: boolean) =>
      this.onMessage(conn, data, isBinary),
    );
    ws.on('close', () => this.dispose(conn));
    ws.on('error', () => this.dispose(conn));

    this.send(conn, {
      type: 'hello',
      serverTime: new Date().toISOString(),
      sessionExpiresAt: session.expiresAt.toISOString(),
      topics: topicsForRole(conn.role),
    });
  }

  // ——— zdarzenia z szyny ———

  private onEvent(event: LiveEvent): void {
    for (const conn of [...this.connections]) {
      if (event.revokedAdminSessionId === conn.sessionId) {
        this.send(conn, { type: 'session', event: 'revoked' });
        this.close(conn, CLOSE.session, 'session revoked');
        continue;
      }
      if (event.adminUserId && event.adminUserId !== conn.adminUserId) continue;
      if (event.exceptAdminSessionId === conn.sessionId) continue;
      const topics = event.topics.filter((topic) =>
        topicAllowed(conn.role, topic),
      );
      if (topics.length > 0) conn.batcher.add(topics);
      const notice = event.notice;
      if (notice && (!notice.topic || topicAllowed(conn.role, notice.topic))) {
        this.send(conn, { type: 'notice', ...notice });
      }
    }
  }

  // ——— wiadomości klienta ———

  private onMessage(conn: Connection, data: RawData, isBinary: boolean): void {
    const raw = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data);
    const parsed = parseClientMessage(raw, isBinary);
    if (!parsed.ok) {
      this.sendError(conn, parsed.code, parsed.message);
      conn.badMessages += 1;
      if (conn.badMessages >= LIVE_LIMITS.badMessages) {
        this.close(conn, CLOSE.badMessages, 'bad messages');
      }
      return;
    }
    this.handleMessage(conn, parsed.message);
  }

  private handleMessage(conn: Connection, message: LiveClientMessage): void {
    switch (message.type) {
      case 'ping':
        this.send(conn, { type: 'pong' });
        return;
      case 'logs.unsubscribe':
        this.stopLogs(conn, message.subscriptionId);
        return;
      case 'logs.subscribe':
        this.subscribeLogs(conn, message);
        return;
    }
  }

  // ——— logi Railway ———

  private subscribeLogs(
    conn: Connection,
    message: Extract<LiveClientMessage, { type: 'logs.subscribe' }>,
  ): void {
    const id = message.subscriptionId;
    if (!roleHasPermission(conn.role, 'ops.logs')) {
      this.sendError(conn, 'FORBIDDEN', 'Brak uprawnienia do logów.', id);
      return;
    }
    const now = Date.now();
    const existing = conn.logs.get(id);
    if (
      existing &&
      existing.serviceId === message.serviceId &&
      existing.requestedDeploymentId === message.deploymentId &&
      existing.kind === message.kind
    ) {
      existing.expiresAt = now + LIVE_LIMITS.logs.ttlMs;
      return;
    }
    if (existing) this.stopLogs(conn, id);
    if (conn.logs.size >= LIVE_LIMITS.logs.perConnection) {
      this.sendError(
        conn,
        'TOO_MANY_SUBSCRIPTIONS',
        `Najwyżej ${LIVE_LIMITS.logs.perConnection} strumienie logów naraz.`,
        id,
      );
      return;
    }
    conn.subscribeStamps = conn.subscribeStamps.filter(
      (at) => now - at < 60_000,
    );
    if (conn.subscribeStamps.length >= LIVE_LIMITS.logs.subscribesPerMinute) {
      this.sendError(conn, 'RATE_LIMITED', 'Za dużo subskrypcji.', id);
      return;
    }
    conn.subscribeStamps.push(now);
    if (!readRailwayToken()) {
      this.sendError(
        conn,
        'LOGS_UNAVAILABLE',
        'Railway nie jest skonfigurowany (ADMIN_RAILWAY_TOKEN).',
        id,
      );
      return;
    }
    const sub: LogSubscription = {
      id,
      serviceId: message.serviceId,
      requestedDeploymentId: message.deploymentId,
      kind: message.kind,
      deploymentId: null,
      tail: new RailwayLogTail(),
      since: now - LIVE_LIMITS.logs.overlapMs,
      expiresAt: now + LIVE_LIMITS.logs.ttlMs,
      timer: null,
      busy: false,
      failures: 0,
      primed: false,
    };
    conn.logs.set(id, sub);
    sub.timer = setInterval(
      () => void this.pollLogs(conn, sub),
      LIVE_LIMITS.logs.pollMs,
    );
    sub.timer.unref();
    void this.pollLogs(conn, sub);
  }

  /** Jedno pobranie subskrypcji (co `pollMs`). */
  private async pollLogs(
    conn: Connection,
    sub: LogSubscription,
  ): Promise<void> {
    if (sub.busy || conn.closed || conn.logs.get(sub.id) !== sub) return;
    if (Date.now() > sub.expiresAt) {
      this.stopLogs(conn, sub.id);
      this.sendError(
        conn,
        'LOGS_EXPIRED',
        'Subskrypcja logów wygasła — odnów ją.',
        sub.id,
      );
      return;
    }
    const token = readRailwayToken();
    if (!token) {
      this.stopLogs(conn, sub.id);
      this.sendError(conn, 'LOGS_UNAVAILABLE', 'Railway wyłączony.', sub.id);
      return;
    }
    sub.busy = true;
    try {
      if (!sub.deploymentId) {
        sub.deploymentId = await resolveRailwayLogDeployment(
          token,
          sub.serviceId,
          sub.requestedDeploymentId,
        );
        if (!sub.deploymentId) {
          throw new IntegrationError('Railway: usługa nie ma wdrożeń');
        }
      }
      const lines = await fetchRailwayLogLinesSince(
        token,
        sub.deploymentId,
        sub.kind,
        new Date(sub.since),
      );
      if (conn.logs.get(sub.id) !== sub) return;
      const fresh = sub.tail.accept(lines);
      sub.failures = 0;
      if (sub.tail.latest !== null) {
        sub.since = Math.max(
          sub.since,
          sub.tail.latest - LIVE_LIMITS.logs.overlapMs,
        );
      }
      // Pierwsze pobranie to linia bazowa: to, co panel ma już z REST-a.
      if (!sub.primed) {
        sub.primed = true;
        return;
      }
      if (fresh.length > 0) {
        this.send(conn, {
          type: 'logs',
          subscriptionId: sub.id,
          lines: fresh,
        });
      }
    } catch (error) {
      sub.failures += 1;
      const message =
        error instanceof IntegrationError
          ? error.message
          : 'Railway: nie udało się pobrać logów';
      if (sub.failures >= LIVE_LIMITS.logs.maxFailures || !sub.deploymentId) {
        this.stopLogs(conn, sub.id);
      }
      this.sendError(conn, 'LOGS_FAILED', message, sub.id);
    } finally {
      sub.busy = false;
    }
  }

  private stopLogs(conn: Connection, id: string): void {
    const sub = conn.logs.get(id);
    if (!sub) return;
    if (sub.timer) clearInterval(sub.timer);
    conn.logs.delete(id);
  }

  // ——— utrzymanie ———

  /** Ponowna walidacja wszystkich kanałów (co minutę; publiczne dla testów). */
  async revalidateAll(now: Date = new Date()): Promise<void> {
    await Promise.all(
      [...this.connections].map((conn) => this.revalidate(conn, now)),
    );
  }

  private async revalidate(conn: Connection, now: Date): Promise<void> {
    if (conn.closed) return;
    try {
      // Świeża weryfikacja JWT Access (mógł wygasnąć) — nie z pamięci żądania.
      conn.req.adminGate = undefined;
      const access = await this.gate.pass(conn.req);
      const session = access
        ? await this.sessions.resolve(conn.req, access.email, now, {
            touch: false,
          })
        : null;
      if (conn.closed) return;
      if (!session || session.id !== conn.sessionId || session.mustReenroll) {
        this.send(conn, { type: 'session', event: 'expired' });
        this.close(conn, CLOSE.session, 'session expired');
        return;
      }
      conn.role = session.admin.role;
      const stepUpNow = stepUpValid(session, now);
      if (stepUpNow) {
        conn.stepUpNotified = false;
      } else if (!conn.stepUpNotified && conn.stepUpUntil) {
        conn.stepUpNotified = true;
        this.send(conn, { type: 'session', event: 'step-up-expired' });
      }
      conn.stepUpUntil = session.stepUpUntil;
    } catch (error) {
      // Awaria bazy to nie wylogowanie — spróbujemy za minutę.
      this.logger.warn(
        `walidacja kanału panelu: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private heartbeat(): void {
    for (const conn of [...this.connections]) {
      if (!conn.alive) {
        conn.ws.terminate();
        this.dispose(conn);
        continue;
      }
      conn.alive = false;
      try {
        conn.ws.ping();
      } catch {
        this.dispose(conn);
      }
    }
  }

  private send(conn: Connection, message: LiveServerMessage): void {
    if (conn.closed || conn.ws.readyState !== WebSocket.OPEN) return;
    try {
      conn.ws.send(JSON.stringify(message));
    } catch {
      // Gniazdo w trakcie zamykania — `close` posprząta.
    }
  }

  private sendError(
    conn: Connection,
    code: LiveErrorCode,
    message: string,
    subscriptionId?: string,
  ): void {
    this.send(conn, {
      type: 'error',
      code,
      message,
      ...(subscriptionId ? { subscriptionId } : {}),
    });
  }

  private close(conn: Connection, code: number, reason: string): void {
    try {
      conn.ws.close(code, reason);
    } catch {
      conn.ws.terminate();
    }
    this.dispose(conn);
  }

  private dispose(conn: Connection): void {
    if (conn.closed) return;
    conn.closed = true;
    conn.batcher.dispose();
    for (const id of [...conn.logs.keys()]) this.stopLogs(conn, id);
    this.connections.delete(conn);
  }
}

// ——— pomocnicze ———

function pathname(url: string | undefined): string {
  const raw = url ?? '';
  const end = raw.search(/[?#]/);
  return end < 0 ? raw : raw.slice(0, end);
}

function isAdminPath(url: string | undefined): boolean {
  const path = pathname(url);
  return path === '/admin' || path.startsWith('/admin/');
}

function headerOf(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first?.trim() || null;
}

/** Ostatni wpis `X-Forwarded-For` (dopisany przez proxy Railway) albo adres gniazda. */
function forwardedIp(req: IncomingMessage): string | null {
  const forwarded = headerOf(req, 'x-forwarded-for');
  const last = (forwarded ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .pop();
  return last || req.socket?.remoteAddress || null;
}

const STATUS_TEXT: Record<number, string> = {
  403: 'Forbidden',
  404: 'Not Found',
  429: 'Too Many Requests',
  503: 'Service Unavailable',
};

/**
 * Odmowa przed upgrade: pełna odpowiedź HTTP w kształcie błędu API
 * (`{ code, message, requestId }`) i zamknięcie gniazda.
 */
function reject(
  socket: Duplex,
  status: number,
  code: string,
  message: string,
  options: { url?: string; retryAfter?: number } = {},
): void {
  if (socket.destroyed || socket.writableEnded) return;
  const body = JSON.stringify({ code, message, requestId: randomUUID() });
  const headers = [
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}`,
    'Connection: close',
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Cache-Control: no-store',
    ...(status !== 404 ? ['X-Robots-Tag: noindex, nofollow'] : []),
    ...(options.retryAfter ? [`Retry-After: ${options.retryAfter}`] : []),
  ];
  try {
    socket.end(`${headers.join('\r\n')}\r\n\r\n${body}`);
  } catch {
    socket.destroy();
  }
  const timer = setTimeout(() => socket.destroy(), 1_000);
  timer.unref();
}
