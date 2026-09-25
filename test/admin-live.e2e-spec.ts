import { randomBytes } from 'crypto';
import { AddressInfo } from 'net';
import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import WebSocket from 'ws';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { emitLive } from '../src/common/live-events';
import { AdminLiveService } from '../src/admin/live/admin-live.service';
import type { LiveServerMessage } from '../src/admin/contract';
import {
  cleanupAdmins,
  createAdminSession,
  useAdminDevGate,
  type AdminE2ESession,
} from './admin-e2e.helper';

/**
 * Kanał na żywo panelu (`/admin/ws`) z PRAWDZIWYM klientem `ws` na
 * uruchomionej aplikacji (`listen(0)`): bramki przy upgrade, `hello`,
 * `invalidate` po zdarzeniu z domeny, odwołanie sesji — i regresja:
 * Socket.IO aplikacji na tym samym serwerze działa jak dawniej.
 */
describe('Panel — kanał na żywo (/admin/ws)', () => {
  let moduleRef: TestingModule;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let restoreGate: () => void;
  let port: number;
  let admin: AdminE2ESession;

  const ORIGIN = 'http://localhost:4000';
  const originals = { ...process.env };
  const TAG = `live-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const createdUserIds: string[] = [];
  const clients: WebSocket[] = [];
  const sockets: Socket[] = [];

  type Opened = {
    ws: WebSocket;
    messages: LiveServerMessage[];
    next: (
      predicate: (m: LiveServerMessage) => boolean,
      timeoutMs?: number,
    ) => Promise<LiveServerMessage>;
    closed: Promise<{ code: number; reason: string }>;
  };

  const url = (path = '/admin/ws') => `ws://127.0.0.1:${port}${path}`;

  /** Odmowa przed upgrade: status HTTP z `unexpected-response`. */
  const rejectedStatus = (
    headers: Record<string, string>,
    path?: string,
  ): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(url(path), { headers });
      clients.push(ws);
      ws.on('open', () => reject(new Error('kanał się otworzył')));
      ws.on('unexpected-response', (_req, res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      ws.on('error', () => undefined);
    });

  const open = (session: AdminE2ESession = admin): Promise<Opened> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(url(), {
        headers: { cookie: session.cookie, origin: ORIGIN },
      });
      clients.push(ws);
      const messages: LiveServerMessage[] = [];
      const waiters: {
        predicate: (m: LiveServerMessage) => boolean;
        resolve: (m: LiveServerMessage) => void;
      }[] = [];
      ws.on('message', (data: Buffer) => {
        const message = JSON.parse(data.toString()) as LiveServerMessage;
        messages.push(message);
        for (const waiter of [...waiters]) {
          if (waiter.predicate(message)) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(message);
          }
        }
      });
      const closed = new Promise<{ code: number; reason: string }>((done) =>
        ws.on('close', (code, reason) =>
          done({ code, reason: reason.toString() }),
        ),
      );
      const next: Opened['next'] = (predicate, timeoutMs = 5_000) => {
        const seen = messages.find(predicate);
        if (seen) {
          messages.splice(messages.indexOf(seen), 1);
          return Promise.resolve(seen);
        }
        return new Promise((ok, fail) => {
          const timer = setTimeout(
            () => fail(new Error('brak oczekiwanej wiadomości')),
            timeoutMs,
          );
          waiters.push({
            predicate,
            resolve: (m) => {
              clearTimeout(timer);
              messages.splice(messages.indexOf(m), 1);
              ok(m);
            },
          });
        });
      };
      ws.on('open', () => resolve({ ws, messages, next, closed }));
      ws.on('unexpected-response', (_req, res) =>
        reject(new Error(`odmowa ${res.statusCode}`)),
      );
      ws.on('error', reject);
    });

  beforeAll(async () => {
    delete process.env.ADMIN_RAILWAY_TOKEN;
    delete process.env.ADMIN_LIVE;
    process.env.ADMIN_WEBAUTHN_ORIGIN = ORIGIN;
    process.env.AUTH_DEV_LOGIN_ENABLED = 'true';
    restoreGate = useAdminDevGate();
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
    prisma = moduleRef.get(PrismaService);
    admin = await createAdminSession(prisma);
  });

  afterEach(() => {
    for (const ws of clients.splice(0)) ws.terminate();
    for (const socket of sockets.splice(0)) socket.disconnect();
  });

  afterAll(async () => {
    await prisma.mailSuppression.deleteMany({
      where: { email: { endsWith: `${TAG}@live.local` } },
    });
    if (createdUserIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await cleanupAdmins(prisma);
    await app.close();
    restoreGate();
    process.env = originals;
  });

  it('bez tokenu Access → 404 (jak brak trasy), także na innej ścieżce /admin', async () => {
    const saved = process.env.ADMIN_ACCESS_DEV_EMAIL;
    delete process.env.ADMIN_ACCESS_DEV_EMAIL;
    try {
      const res = await rejectedStatus({
        cookie: admin.cookie,
        origin: ORIGIN,
      });
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      process.env.ADMIN_ACCESS_DEV_EMAIL = saved;
    }
    const other = await rejectedStatus(
      { cookie: admin.cookie, origin: ORIGIN },
      '/admin/nie-ma',
    );
    expect(other.status).toBe(404);
  });

  it('zły albo brak Origin → 403', async () => {
    const evil = await rejectedStatus({
      cookie: admin.cookie,
      origin: 'https://evil.example',
    });
    expect(evil.status).toBe(403);
    expect(JSON.parse(evil.body)).toMatchObject({ code: 'CROSS_SITE' });
    const none = await rejectedStatus({ cookie: admin.cookie });
    expect(none.status).toBe(403);
  });

  it('bez sesji / z sesją do ponownego wpisania → 404', async () => {
    expect((await rejectedStatus({ origin: ORIGIN })).status).toBe(404);
    const reenroll = await createAdminSession(prisma, { mustReenroll: true });
    expect(
      (await rejectedStatus({ cookie: reenroll.cookie, origin: ORIGIN }))
        .status,
    ).toBe(404);
  });

  it('z sesją → hello z tematami; ping → pong; zła wiadomość → error, druga → zamknięcie 4400', async () => {
    const live = await open();
    const hello = await live.next((m) => m.type === 'hello');
    expect(hello).toMatchObject({ type: 'hello' });
    if (hello.type !== 'hello') throw new Error('hello');
    expect(hello.topics).toEqual(
      expect.arrayContaining(['users', 'mail', 'admin-sessions']),
    );
    expect(Date.parse(hello.sessionExpiresAt)).toBeGreaterThan(Date.now());

    live.ws.send(JSON.stringify({ type: 'ping' }));
    await live.next((m) => m.type === 'pong');

    live.ws.send('{"type":"nieznany"}');
    expect(await live.next((m) => m.type === 'error')).toMatchObject({
      code: 'BAD_MESSAGE',
    });
    live.ws.send('x'.repeat(5_000));
    expect((await live.closed).code).toBe(4400);
  });

  it('logi bez tokenu Railway → error LOGS_UNAVAILABLE z id subskrypcji', async () => {
    const live = await open();
    await live.next((m) => m.type === 'hello');
    live.ws.send(
      JSON.stringify({
        type: 'logs.subscribe',
        subscriptionId: 's1',
        serviceId: 'svc-1',
        kind: 'deploy',
      }),
    );
    expect(await live.next((m) => m.type === 'error')).toMatchObject({
      code: 'LOGS_UNAVAILABLE',
      subscriptionId: 's1',
    });
  });

  it('zmiana z panelu (wykluczenie poczty) → jedno invalidate z tematami mail + audit', async () => {
    const live = await open();
    await live.next((m) => m.type === 'hello');
    await request(app.getHttpServer())
      .post('/admin/mail/suppressions')
      .set('Cookie', admin.cookie)
      .send({ email: `recznie-${TAG}@live.local`, reason: 'test kanału' })
      .expect(204);
    const invalidate = await live.next((m) => m.type === 'invalidate');
    if (invalidate.type !== 'invalidate') throw new Error('invalidate');
    expect(invalidate.topics).toEqual(
      expect.arrayContaining(['mail', 'audit']),
    );
  });

  it('zdarzenie z domeny (nowe konto) → notice + invalidate users/dashboard; seria = jedna wiadomość', async () => {
    const live = await open();
    await live.next((m) => m.type === 'hello');
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({ displayName: `Live ${TAG}`, email: `konto-${TAG}@live.local` })
      .expect(201);
    createdUserIds.push((res.body as { user: { id: string } }).user.id);
    // Dev-login nie jest „nowym kontem” z Apple/Google — sygnał emitujemy
    // tak, jak robi to rejestracja, żeby sprawdzić drogę szyna → gniazdo.
    emitLive({
      topics: ['users', 'dashboard'],
      notice: { level: 'success', title: 'Nowe konto: Ala', topic: 'users' },
    });
    emitLive({ topics: ['dashboard'] });
    emitLive({ topics: ['assistant'] });
    const notice = await live.next((m) => m.type === 'notice');
    expect(notice).toMatchObject({
      title: 'Nowe konto: Ala',
      level: 'success',
    });
    const invalidate = await live.next((m) => m.type === 'invalidate');
    if (invalidate.type !== 'invalidate') throw new Error('invalidate');
    expect(invalidate.topics).toEqual(['dashboard', 'users', 'assistant']);
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    expect(live.messages.filter((m) => m.type === 'invalidate')).toHaveLength(
      0,
    );
  });

  it('odwołanie sesji z „Bezpieczeństwa” → session revoked i zamknięcie 4401', async () => {
    const other = await createAdminSession(prisma);
    const live = await open(other);
    await live.next((m) => m.type === 'hello');
    await request(app.getHttpServer())
      .delete(`/admin/auth/sessions/${other.sessionId}`)
      .set('Cookie', admin.cookie)
      .expect(204);
    expect(await live.next((m) => m.type === 'session')).toEqual({
      type: 'session',
      event: 'revoked',
    });
    expect((await live.closed).code).toBe(4401);
  });

  it('ponowna walidacja: sesja wygasła w bazie → session expired i 4401; lastSeenAt nieruszony', async () => {
    const other = await createAdminSession(prisma);
    const live = await open(other);
    await live.next((m) => m.type === 'hello');
    const before = await prisma.adminSession.findUniqueOrThrow({
      where: { id: other.sessionId },
    });
    const service = app.get(AdminLiveService);
    await service.revalidateAll(new Date(Date.now() + 5 * 60_000));
    const after = await prisma.adminSession.findUniqueOrThrow({
      where: { id: other.sessionId },
    });
    expect(after.lastSeenAt.getTime()).toBe(before.lastSeenAt.getTime());
    expect(live.messages.some((m) => m.type === 'session')).toBe(false);

    await prisma.adminSession.update({
      where: { id: other.sessionId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    await service.revalidateAll();
    expect(await live.next((m) => m.type === 'session')).toEqual({
      type: 'session',
      event: 'expired',
    });
    expect((await live.closed).code).toBe(4401);
  });

  it('ADMIN_LIVE=false → kanał wyłączony (gniazdo zerwane bez 101)', async () => {
    process.env.ADMIN_LIVE = 'false';
    try {
      const outcome = await new Promise<string>((resolve) => {
        const ws = new WebSocket(url(), {
          headers: { cookie: admin.cookie, origin: ORIGIN },
        });
        clients.push(ws);
        ws.on('open', () => resolve('open'));
        ws.on('unexpected-response', () => resolve('response'));
        ws.on('error', () => resolve('error'));
      });
      expect(outcome).toBe('error');
    } finally {
      delete process.env.ADMIN_LIVE;
    }
  });

  it('REGRESJA: Socket.IO aplikacji przechodzi handshake przy włączonym kanale panelu', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({ displayName: `WS ${TAG}`, email: `ws-${TAG}@live.local` })
      .expect(201);
    const session = res.body as {
      accessToken: string;
      user: { id: string };
    };
    createdUserIds.push(session.user.id);
    // Otwarty kanał panelu obok — oba serwery na jednym porcie.
    const live = await open();
    await live.next((m) => m.type === 'hello');

    const socket = io(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { token: session.accessToken },
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', (err: Error) => reject(err));
    });
    expect(socket.connected).toBe(true);
    // Polling (pierwszy krok domyślnego klienta) idzie zwykłym HTTP.
    const polling = io(`http://127.0.0.1:${port}`, {
      transports: ['polling', 'websocket'],
      forceNew: true,
      reconnection: false,
      auth: { token: session.accessToken },
    });
    sockets.push(polling);
    await new Promise<void>((resolve, reject) => {
      polling.once('connect', () => resolve());
      polling.once('connect_error', (err: Error) => reject(err));
    });
  });

  it('REGRESJA: obca ścieżka z Upgrade dalej ginie jak dawniej (engine.io)', async () => {
    const outcome = await new Promise<string>((resolve) => {
      const ws = new WebSocket(url('/nie-socket'));
      clients.push(ws);
      ws.on('open', () => resolve('open'));
      ws.on('unexpected-response', () => resolve('response'));
      ws.on('error', () => resolve('error'));
    });
    expect(outcome).toBe('error');
  });
});
