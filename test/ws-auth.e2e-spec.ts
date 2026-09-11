import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { AddressInfo } from 'net';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Auth WebSocketu (Faza 0, krok 1) — kontrakt handshake'u, tożsamość
 * z socketu, pokoje per gospodarstwo, tryby soft/strict, logout i
 * reuse-detection refresh tokenu. Tryb jest czytany per handshake, więc test
 * przełącza `WS_AUTH_MODE` w procesie i przywraca po sobie.
 */
type WsEnvelope<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: string;
      message?: string;
      code: string;
      status?: number;
      requestId?: string;
    };

type Session = {
  accessToken: string;
  refreshToken: string;
  user: { id: string; displayName: string };
  household: { id: string; name: string } | null;
};

type HandshakeError = Error & {
  data?: { code?: string; reason?: string; requestId?: string };
};

describe('WS auth E2E', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];
  const createdRecipeIds: string[] = [];
  const sockets: Socket[] = [];
  const originalMode = process.env.WS_AUTH_MODE;

  const opsHeaders = (): Record<string, string> =>
    process.env.OPS_TOKEN ? { 'x-ops-token': process.env.OPS_TOKEN } : {};

  const devLogin = async (label: string): Promise<Session> => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `${label} ${stamp}`,
        email: `${label.toLowerCase()}-${stamp}@ws-auth.local`,
      })
      .expect(201);
    const session = res.body as Session;
    createdUserIds.push(session.user.id);
    return session;
  };

  const connect = (
    opts: { token?: string; headers?: Record<string, string> } = {},
  ): Socket => {
    const socket = io(baseUrl, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      ...(opts.token ? { auth: { token: opts.token } } : {}),
      ...(opts.headers ? { extraHeaders: opts.headers } : {}),
    });
    sockets.push(socket);
    return socket;
  };

  const waitConnect = (socket: Socket): Promise<void> =>
    new Promise((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', (err: Error) => reject(err));
    });

  const expectHandshakeRejected = async (
    socket: Socket,
  ): Promise<HandshakeError> =>
    new Promise((resolve, reject) => {
      socket.once('connect', () =>
        reject(new Error('socket connected, expected connect_error')),
      );
      socket.once('connect_error', (err: HandshakeError) => resolve(err));
    });

  const ack = <T>(
    socket: Socket,
    event: string,
    payload: unknown,
  ): Promise<WsEnvelope<T>> =>
    new Promise((resolve, reject) => {
      socket
        .timeout(7000)
        .emit(event, payload, (err: Error | null, response: WsEnvelope<T>) => {
          if (err) reject(err);
          else resolve(response);
        });
    });

  const waitEvent = <T>(
    socket: Socket,
    event: string,
    timeoutMs = 5000,
  ): Promise<T> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timeout waiting for ${event}`)),
        timeoutMs,
      );
      socket.once(event, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

  const expectNoEvent = (
    socket: Socket,
    event: string,
    windowMs = 700,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      const onEvent = (payload: unknown) => {
        clearTimeout(timer);
        reject(new Error(`Unexpected ${event}: ${JSON.stringify(payload)}`));
      };
      const timer = setTimeout(() => {
        socket.off(event, onEvent);
        resolve();
      }, windowMs);
      socket.once(event, onEvent);
    });

  const nextMonday = (): string => {
    const now = new Date();
    const daysUntilMonday = (8 - now.getUTCDay()) % 7 || 7;
    return new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + daysUntilMonday,
      ),
    )
      .toISOString()
      .slice(0, 10);
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
  });

  afterEach(() => {
    if (originalMode === undefined) delete process.env.WS_AUTH_MODE;
    else process.env.WS_AUTH_MODE = originalMode;
    for (const socket of sockets.splice(0)) socket.disconnect();
  });

  afterAll(async () => {
    if (createdRecipeIds.length) {
      await prisma.recipe.deleteMany({
        where: { id: { in: createdRecipeIds } },
      });
    }
    if (createdHouseholdIds.length) {
      await prisma.household.deleteMany({
        where: { id: { in: createdHouseholdIds } },
      });
    }
    if (createdUserIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  describe('handshake', () => {
    it('strict: bez tokenu → connect_error UNAUTHORIZED/missing', async () => {
      process.env.WS_AUTH_MODE = 'strict';
      const err = await expectHandshakeRejected(connect());
      expect(err.message).toBe('Missing access token');
      expect(err.data).toMatchObject({
        code: 'UNAUTHORIZED',
        reason: 'missing',
        requestId: expect.any(String),
      });
    });

    it.each(['soft', 'strict'])(
      '%s: śmieciowy token → connect_error UNAUTHORIZED/invalid',
      async (mode) => {
        process.env.WS_AUTH_MODE = mode;
        const err = await expectHandshakeRejected(
          connect({ token: 'not-a-jwt' }),
        );
        expect(err.data).toMatchObject({
          code: 'UNAUTHORIZED',
          reason: 'invalid',
        });
      },
    );

    it('ważny token skasowanego konta → connect_error UNAUTHORIZED/user_gone', async () => {
      const ghost = await devLogin('Ghost');
      await prisma.user.delete({ where: { id: ghost.user.id } });
      createdUserIds.splice(createdUserIds.indexOf(ghost.user.id), 1);

      const err = await expectHandshakeRejected(
        connect({ token: ghost.accessToken }),
      );
      expect(err.data).toMatchObject({ reason: 'user_gone' });
    });

    it('token z nagłówka Authorization: Bearer też otwiera socket', async () => {
      process.env.WS_AUTH_MODE = 'strict';
      const session = await devLogin('Header');
      const socket = connect({
        headers: { authorization: `Bearer ${session.accessToken}` },
      });
      await waitConnect(socket);
      const me = await ack<{ id: string }>(socket, 'users:me', {});
      expect(me.ok && me.data.id).toBe(session.user.id);
    });

    it('soft: bez tokenu → legacy: userId z payloadu działa, bez userId → UNAUTHORIZED', async () => {
      process.env.WS_AUTH_MODE = 'soft';
      const session = await devLogin('Legacy');
      const socket = connect();
      await waitConnect(socket);

      const withId = await ack<{ id: string }>(socket, 'users:me', {
        userId: session.user.id,
      });
      expect(withId.ok && withId.data.id).toBe(session.user.id);

      const withoutId = await ack(socket, 'users:me', {});
      expect(withoutId).toMatchObject({
        ok: false,
        code: 'UNAUTHORIZED',
        status: 401,
      });
    });
  });

  describe('tożsamość z socketu', () => {
    it('payload.userId innego usera jest ignorowany — działa tożsamość z tokenu', async () => {
      const before = (
        await request(app.getHttpServer())
          .get('/ops/metrics')
          .set(opsHeaders())
          .expect(200)
      ).body.http.wsAuth;

      const victim = await devLogin('Victim');
      const attacker = await devLogin('Attacker');
      const socket = connect({ token: attacker.accessToken });
      await waitConnect(socket);

      const me = await ack<{ id: string }>(socket, 'users:me', {
        userId: victim.user.id,
      });
      expect(me.ok && me.data.id).toBe(attacker.user.id);

      await expectHandshakeRejected(connect({ token: 'garbage' }));

      const after = (
        await request(app.getHttpServer())
          .get('/ops/metrics')
          .set(opsHeaders())
          .expect(200)
      ).body.http.wsAuth;
      // Delty, nie wartości bezwzględne — inne testy w tym procesie też
      // liczą handshake'i.
      expect(after.payloadMismatch - before.payloadMismatch).toBe(1);
      expect(after.handshakes.token - before.handshakes.token).toBe(1);
      expect(after.handshakes.rejected - before.handshakes.rejected).toBe(1);
      expect(after.rejectedByReason.invalid ?? 0).toBeGreaterThanOrEqual(1);
    });
  });

  describe('pokoje per gospodarstwo', () => {
    it('zdarzenia domu A trafiają do członków A (także dołączonego w trakcie), nie do B', async () => {
      process.env.WS_AUTH_MODE = 'strict';
      const owner = await devLogin('OwnerA');
      const joiner = await devLogin('JoinerA');
      const outsider = await devLogin('OwnerB');

      const ownerSocket = connect({ token: owner.accessToken });
      const joinerSocket = connect({ token: joiner.accessToken });
      const outsiderSocket = connect({ token: outsider.accessToken });
      await Promise.all([
        waitConnect(ownerSocket),
        waitConnect(joinerSocket),
        waitConnect(outsiderSocket),
      ]);

      const householdA = await ack<{ id: string }>(
        ownerSocket,
        'households:create',
        { data: { name: 'Dom A' } },
      );
      expect(householdA.ok).toBe(true);
      if (!householdA.ok) return;
      createdHouseholdIds.push(householdA.data.id);

      const householdB = await ack<{ id: string }>(
        outsiderSocket,
        'households:create',
        { data: { name: 'Dom B' } },
      );
      expect(householdB.ok).toBe(true);
      if (!householdB.ok) return;
      createdHouseholdIds.push(householdB.data.id);

      // Joiner był już połączony, zanim został domownikiem — jego żywy
      // socket musi trafić do pokoju A przez socketsJoin, nie przez reconnect.
      const invitation = await ack<{ token: string }>(
        ownerSocket,
        'households:createInvitation',
        { householdId: householdA.data.id, data: {} },
      );
      expect(invitation.ok).toBe(true);
      if (!invitation.ok) return;

      const membersChanged = waitEvent<{
        householdId: string;
        members?: unknown[];
      }>(joinerSocket, 'households:membersChanged');
      const accepted = await ack<{ householdId: string }>(
        joinerSocket,
        'households:acceptInvitation',
        { data: { token: invitation.data.token } },
      );
      expect(accepted.ok).toBe(true);
      expect((await membersChanged).householdId).toBe(householdA.data.id);

      const recipe = await prisma.recipe.create({
        data: {
          title: 'WS auth E2E recipe',
          description: 'pokoje',
          mealType: 'BREAKFAST',
          difficulty: 'EASY',
          prepTimeMinutes: 5,
          servings: 1,
          authorId: owner.user.id,
          householdId: householdA.data.id,
          nutritionKcal: 100,
        },
        select: { id: true },
      });
      createdRecipeIds.push(recipe.id);

      const joinerSees = waitEvent<{ householdId: string }>(
        joinerSocket,
        'weeklyPlans:weekChanged',
      );
      const outsiderSilent = expectNoEvent(
        outsiderSocket,
        'weeklyPlans:weekChanged',
      );
      const upsert = await ack(ownerSocket, 'weeklyPlans:upsertWeekSlot', {
        householdId: householdA.data.id,
        weekStart: nextMonday(),
        data: { dayOfWeek: 'MON', mealType: 'BREAKFAST', recipeId: recipe.id },
      });
      expect(upsert.ok).toBe(true);
      expect((await joinerSees).householdId).toBe(householdA.data.id);
      await outsiderSilent;

      // Członkostwo w cudzym domu nadal jest sprawdzane per handler.
      const foreign = await ack(outsiderSocket, 'weeklyPlans:getByWeek', {
        householdId: householdA.data.id,
        weekStart: nextMonday(),
      });
      expect(foreign).toMatchObject({
        ok: false,
        code: 'NOT_HOUSEHOLD_MEMBER',
      });
    });
  });

  describe('koniec sesji', () => {
    it('users:delete rozłącza sockety usera, a jego token nie otwiera nowego', async () => {
      process.env.WS_AUTH_MODE = 'strict';
      const doomed = await devLogin('Doomed');
      const socket = connect({ token: doomed.accessToken });
      await waitConnect(socket);

      const disconnected = new Promise<string>((resolve) =>
        socket.once('disconnect', (reason: string) => resolve(reason)),
      );
      const deleted = await ack(socket, 'users:delete', {});
      expect(deleted.ok).toBe(true);
      // `disconnectSockets(true)` zamyka engine — klient widzi zerwanie
      // transportu; ważne jest, że ack doszedł PRZED rozłączeniem.
      expect(typeof (await disconnected)).toBe('string');
      createdUserIds.splice(createdUserIds.indexOf(doomed.user.id), 1);

      const err = await expectHandshakeRejected(
        connect({ token: doomed.accessToken }),
      );
      expect(err.data).toMatchObject({ reason: 'user_gone' });
    });

    it('POST /auth/logout unieważnia refresh token; ponowne użycie → 401', async () => {
      const session = await devLogin('Logout');

      const logout = await request(app.getHttpServer())
        .post('/auth/logout')
        .send({ refreshToken: session.refreshToken })
        .expect(200);
      expect(logout.body).toEqual({ revoked: true });

      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);

      const again = await request(app.getHttpServer())
        .post('/auth/logout')
        .send({ refreshToken: session.refreshToken })
        .expect(200);
      expect(again.body).toEqual({ revoked: false });
    });

    it('reuse refresh tokenu unieważnia całą rodzinę', async () => {
      const session = await devLogin('Reuse');

      const rotated = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(201);
      const fresh = rotated.body.refreshToken as string;
      expect(fresh).not.toBe(session.refreshToken);

      // Klient UŻYWA nowej pary — to dowód, że ją dostał. Bez tego kroku
      // powtórzenie starego tokenu jest nieodróżnialne od zgubionej
      // odpowiedzi z rotacji i serwer słusznie je ratuje (test niżej).
      const second = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: fresh })
        .expect(201);
      const newest = second.body.refreshToken as string;

      // Replay starego tokenu = ktoś ma kopię → cała rodzina ma paść.
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: newest })
        .expect(401);
    });

    // Telefon wysłał refresh, serwer zrotował token, iOS uśpił proces i
    // odpowiedź nie dojechała — w Keychain został STARY token. To NIE jest
    // kradzież i nie może kończyć się wylogowaniem („Sesja wygasła”).
    it('zgubiona odpowiedź z rotacji: powtórzenie w oknie łaski oddaje świeżą parę', async () => {
      const session = await devLogin('LostRotation');

      const rotated = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(201);
      // `rotated.body.refreshToken` udaje parę, która nigdy nie dotarła —
      // nikt jej nie używa.
      const lost = rotated.body.refreshToken as string;

      const recovered = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(201);
      expect(recovered.body.refreshToken).not.toBe(lost);
      expect(recovered.body.refreshToken).not.toBe(session.refreshToken);

      // Porzucona para jest martwa, a odratowana działa.
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: lost })
        .expect(401);
    });

    it('ratunek jest jednorazowy — drugie powtórzenie tego samego tokenu to 401', async () => {
      const session = await devLogin('LostRotationOnce');

      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(201);
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(201);
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
    });

    // Telefon ma single-flight, ale POST i tak potrafi pójść dwa razy: gdy
    // połączenie padnie, zanim odpowiedź dojedzie, URLSession ponawia żądanie
    // i serwer dostaje dwa refreshe tym samym tokenem w tej samej sekundzie.
    // Do 11.09.2026 przegrany tę turę dostawał 401, rodzina padała, a telefon
    // pokazywał „Sesja wygasła”.
    it('dwa równoległe refreshe tym samym tokenem nie kończą sesji', async () => {
      const session = await devLogin('RownolegleOdswiezenie');

      const [first, second] = await Promise.all([
        request(app.getHttpServer())
          .post('/auth/refresh')
          .send({ refreshToken: session.refreshToken }),
        request(app.getHttpServer())
          .post('/auth/refresh')
          .send({ refreshToken: session.refreshToken }),
      ]);

      // Żadne z nich nie jest replayem — jedno rotuje, drugie ratuje się
      // oknem łaski, obie strony dostają parę.
      expect([first.status, second.status]).toEqual([201, 201]);
      expect(first.body.refreshToken).not.toBe(session.refreshToken);
      expect(second.body.refreshToken).not.toBe(session.refreshToken);
      expect(first.body.refreshToken).not.toBe(second.body.refreshToken);

      // Rodzina nie padła, więc `tokenVersion` nie poszło w górę i tokeny
      // DOSTĘPU z obu odpowiedzi nadal otwierają REST.
      for (const accessToken of [
        first.body.accessToken as string,
        second.body.accessToken as string,
      ]) {
        await request(app.getHttpServer())
          .get('/integrations/cookidoo/status')
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(200);
      }
    });

    it('REST z tokenem skasowanego konta → 401 UNAUTHORIZED/user_gone', async () => {
      const ghost = await devLogin('RestGhost');
      await prisma.user.delete({ where: { id: ghost.user.id } });
      createdUserIds.splice(createdUserIds.indexOf(ghost.user.id), 1);

      const res = await request(app.getHttpServer())
        .get('/integrations/cookidoo/status')
        .set('Authorization', `Bearer ${ghost.accessToken}`)
        .expect(401);
      expect(res.body).toMatchObject({
        code: 'UNAUTHORIZED',
        details: ['user_gone'],
      });
    });
  });
});
