import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Asystent AI (Faza 0, krok 3) na żywym serwerze, z dostawcą `stub`.
 *
 * Sprawdza CAŁY tor tury bez ani jednego wywołania modelu: 202 + `Location`,
 * polling do DONE, idempotencja po `clientMessageId`, lease rozmowy, kwota i
 * jej zwrot po nieudanej turze, bezpiecznik wejścia (`AI_ENABLED=false`),
 * kasowanie rozmów i metryki. Klucza Anthropica jeszcze nie ma, a płatny
 * dostawca w CI byłby złym pomysłem — stąd stub jako część kodu, nie mock DI.
 *
 * Wszystkie `AI_*` i limity throttlera są czytane z env per żądanie, więc
 * suita przełącza je w locie i przywraca po sobie.
 */
type Session = {
  accessToken: string;
  user: { id: string; displayName: string };
  household: { id: string } | null;
};

type Conversation = {
  id: string;
  householdId: string;
  status: string;
  createdAt: string;
};

type AcceptedTurn = {
  turnId: string;
  messageId: string;
  status: string;
  requestId: string;
};

type TurnView = {
  id: string;
  conversationId: string;
  status: string;
  errorCode: string | null;
  messages?: { role: string; text: string }[];
  usage?: { inputTokens: number; outputTokens: number; costMicroUsd: number };
};

const WEEK_START = '2026-08-31';
const CLIENT_TODAY = '2026-09-02';
const TIME_ZONE = 'Europe/Warsaw';

describe('Agent E2E', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let session: Session;
  let householdId: string;
  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];
  const usageScopeIds: string[] = [];

  const ENV_KEYS = [
    'AI_ENABLED',
    'AI_PROVIDER',
    'AI_STUB_DELAY_MS',
    'AI_LIMIT_MESSAGES_PER_MONTH',
    'THROTTLE_DEFAULT_LIMIT',
    'THROTTLE_IP_LIMIT',
    'THROTTLE_AGENT_MESSAGE_LIMIT',
    'THROTTLE_AGENT_POLL_LIMIT',
  ] as const;
  const original: Record<string, string | undefined> = {};

  const opsHeaders = (): Record<string, string> =>
    process.env.OPS_TOKEN ? { 'x-ops-token': process.env.OPS_TOKEN } : {};

  const devLogin = async (label: string): Promise<Session> => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `${label} ${stamp}`,
        email: `${label.toLowerCase()}-${stamp}@agent.local`,
      })
      .expect(201);
    const created = res.body as Session;
    createdUserIds.push(created.user.id);
    if (created.household) createdHouseholdIds.push(created.household.id);
    return created;
  };

  /** Dev-login nie zakłada gospodarstwa; tu nie testujemy WS, więc wprost. */
  const createHousehold = async (userId: string, name: string) => {
    const household = await prisma.household.create({
      data: { name, createdById: userId },
    });
    await prisma.membership.create({
      data: { userId, householdId: household.id, role: 'OWNER' },
    });
    createdHouseholdIds.push(household.id);
    usageScopeIds.push(household.id);
    return household.id;
  };

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const createConversation = async (
    token: string,
    household: string,
  ): Promise<Conversation> => {
    const res = await request(app.getHttpServer())
      .post('/agent/conversations')
      .set(auth(token))
      .send({ householdId: household })
      .expect(201);
    return res.body as Conversation;
  };

  const postMessage = (
    token: string,
    conversationId: string,
    body: Record<string, unknown>,
  ) =>
    request(app.getHttpServer())
      .post(`/agent/conversations/${conversationId}/messages`)
      .set(auth(token))
      .send({
        weekStart: WEEK_START,
        clientToday: CLIENT_TODAY,
        timeZone: TIME_ZONE,
        ...body,
      });

  const pollTurn = async (
    token: string,
    turnId: string,
    timeoutMs = 15_000,
  ): Promise<TurnView> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await request(app.getHttpServer())
        .get(`/agent/turns/${turnId}`)
        .set(auth(token))
        .expect(200);
      const turn = res.body as TurnView;
      if (turn.status !== 'RUNNING') return turn;
      if (Date.now() > deadline)
        throw new Error(`tura ${turnId} wisi w RUNNING`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };

  const monthKey = () => new Date().toISOString().slice(0, 7);

  const readQuota = async (scopeId: string) => {
    const row = await prisma.aiUsageCounter.findUnique({
      where: {
        scopeId_periodKey_kind: {
          scopeId,
          periodKey: monthKey(),
          kind: 'messages',
        },
      },
    });
    return row?.value ?? 0;
  };

  beforeAll(async () => {
    for (const key of ENV_KEYS) original[key] = process.env[key];
    process.env.AI_ENABLED = 'true';
    process.env.AI_PROVIDER = 'stub';
    process.env.AI_STUB_DELAY_MS = '0';
    delete process.env.AI_LIMIT_MESSAGES_PER_MONTH;
    // Polling tury robi dziesiątki żądań na turę — limity throttlera są
    // przedmiotem `throttling.e2e-spec.ts`, nie tej suity.
    process.env.THROTTLE_DEFAULT_LIMIT = '10000';
    process.env.THROTTLE_IP_LIMIT = '10000';
    process.env.THROTTLE_AGENT_MESSAGE_LIMIT = '10000';
    process.env.THROTTLE_AGENT_POLL_LIMIT = '10000';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    session = await devLogin('Asystent');
    householdId = await createHousehold(
      session.user.id,
      `Dom asystenta ${Date.now()}`,
    );
  });

  afterAll(async () => {
    if (usageScopeIds.length) {
      await prisma.aiUsageCounter.deleteMany({
        where: { scopeId: { in: usageScopeIds } },
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
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    await app.close();
  });

  describe('dostęp', () => {
    it('bez tokenu: 401 UNAUTHORIZED', async () => {
      const res = await request(app.getHttpServer())
        .get('/agent/conversations')
        .expect(401);
      expect(res.body).toMatchObject({ code: 'UNAUTHORIZED' });
    });

    it('rozmowa w cudzym gospodarstwie: 403 NOT_HOUSEHOLD_MEMBER', async () => {
      const other = await devLogin('Obcy');
      const otherHousehold = await createHousehold(
        other.user.id,
        `Cudzy dom ${Date.now()}`,
      );
      const res = await request(app.getHttpServer())
        .post('/agent/conversations')
        .set(auth(session.accessToken))
        .send({ householdId: otherHousehold })
        .expect(403);
      expect(res.body).toMatchObject({ code: 'NOT_HOUSEHOLD_MEMBER' });
    });

    it('householdId nie-UUID: 400 VALIDATION_ERROR (nie 500 z P2023)', async () => {
      const res = await request(app.getHttpServer())
        .post('/agent/conversations')
        .set(auth(session.accessToken))
        .send({ householdId: 'hh-1' })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('tura', () => {
    it('202 z Location, polling do DONE i odpowiedź asystenta', async () => {
      const conversation = await createConversation(
        session.accessToken,
        householdId,
      );
      expect(conversation).toMatchObject({
        householdId,
        status: 'OPEN',
      });

      const before = await readQuota(householdId);
      const accepted = await postMessage(session.accessToken, conversation.id, {
        clientMessageId: randomUUID(),
        text: 'Co na obiad?',
      }).expect(202);

      const turn = accepted.body as AcceptedTurn;
      expect(turn).toMatchObject({
        status: 'RUNNING',
        requestId: expect.any(String),
      });
      expect(accepted.headers.location).toBe(`/agent/turns/${turn.turnId}`);

      const done = await pollTurn(session.accessToken, turn.turnId);
      expect(done.status).toBe('DONE');
      expect(done.errorCode).toBeNull();
      expect(done.messages?.[0]).toMatchObject({
        role: 'ASSISTANT',
        text: '[stub] Co na obiad?',
      });
      expect(done.usage?.outputTokens).toBeGreaterThan(0);

      // Kwota schodzi na starcie tury i przy sukcesie zostaje zdjęta.
      expect(await readQuota(householdId)).toBe(before + 1);

      const history = await request(app.getHttpServer())
        .get(`/agent/conversations/${conversation.id}/messages`)
        .set(auth(session.accessToken))
        .expect(200);
      expect(history.body.messages).toHaveLength(2);
      expect(history.body.messages[0].role).toBe('USER');
    });

    it('ten sam clientMessageId oddaje TĘ SAMĄ turę i nie zdejmuje kwoty drugi raz', async () => {
      const conversation = await createConversation(
        session.accessToken,
        householdId,
      );
      const clientMessageId = randomUUID();
      const first = await postMessage(session.accessToken, conversation.id, {
        clientMessageId,
        text: 'Powtórka',
      }).expect(202);
      const firstTurn = first.body as AcceptedTurn;
      await pollTurn(session.accessToken, firstTurn.turnId);

      const quotaAfterFirst = await readQuota(householdId);
      const second = await postMessage(session.accessToken, conversation.id, {
        clientMessageId,
        text: 'Powtórka',
      }).expect(202);

      expect((second.body as AcceptedTurn).turnId).toBe(firstTurn.turnId);
      expect(await readQuota(householdId)).toBe(quotaAfterFirst);
    });

    it('druga wiadomość w zajętej rozmowie: 409 AI_TURN_IN_PROGRESS', async () => {
      process.env.AI_STUB_DELAY_MS = '1500';
      try {
        const conversation = await createConversation(
          session.accessToken,
          householdId,
        );
        const first = await postMessage(session.accessToken, conversation.id, {
          clientMessageId: randomUUID(),
          text: 'Długa tura',
        }).expect(202);

        const blocked = await postMessage(
          session.accessToken,
          conversation.id,
          { clientMessageId: randomUUID(), text: 'Druga' },
        ).expect(409);
        expect(blocked.body).toMatchObject({ code: 'AI_TURN_IN_PROGRESS' });

        await pollTurn(
          session.accessToken,
          (first.body as AcceptedTurn).turnId,
        );
      } finally {
        process.env.AI_STUB_DELAY_MS = '0';
      }
    });

    it('cudza tura: 404 AI_TURN_NOT_FOUND', async () => {
      const conversation = await createConversation(
        session.accessToken,
        householdId,
      );
      const accepted = await postMessage(session.accessToken, conversation.id, {
        clientMessageId: randomUUID(),
        text: 'Moja tura',
      }).expect(202);
      const turnId = (accepted.body as AcceptedTurn).turnId;
      await pollTurn(session.accessToken, turnId);

      const intruder = await devLogin('Podglądacz');
      const res = await request(app.getHttpServer())
        .get(`/agent/turns/${turnId}`)
        .set(auth(intruder.accessToken))
        .expect(404);
      expect(res.body).toMatchObject({ code: 'AI_TURN_NOT_FOUND' });
    });

    it('błąd dostawcy: tura FAILED i kwota wraca', async () => {
      const conversation = await createConversation(
        session.accessToken,
        householdId,
      );
      const before = await readQuota(householdId);
      const accepted = await postMessage(session.accessToken, conversation.id, {
        clientMessageId: randomUUID(),
        text: 'Padnij [[upstream-error]]',
      }).expect(202);

      const failed = await pollTurn(
        session.accessToken,
        (accepted.body as AcceptedTurn).turnId,
      );
      expect(failed.status).toBe('FAILED');
      expect(failed.errorCode).toBe('AI_PROVIDER_ERROR');
      expect(failed.messages).toBeUndefined();
      // Użytkownik nie płaci za awarię dostawcy.
      expect(await readQuota(householdId)).toBe(before);
    });
  });

  describe('limity i przełączniki', () => {
    it('wyczerpana kwota: 429 AI_QUOTA_EXCEEDED', async () => {
      const quotaUser = await devLogin('Kwota');
      const quotaHousehold = await createHousehold(
        quotaUser.user.id,
        `Dom kwoty ${Date.now()}`,
      );
      process.env.AI_LIMIT_MESSAGES_PER_MONTH = '2';
      try {
        const conversation = await createConversation(
          quotaUser.accessToken,
          quotaHousehold,
        );
        for (let i = 0; i < 2; i += 1) {
          const accepted = await postMessage(
            quotaUser.accessToken,
            conversation.id,
            { clientMessageId: randomUUID(), text: `Wiadomość ${i}` },
          ).expect(202);
          await pollTurn(
            quotaUser.accessToken,
            (accepted.body as AcceptedTurn).turnId,
          );
        }

        const blocked = await postMessage(
          quotaUser.accessToken,
          conversation.id,
          { clientMessageId: randomUUID(), text: 'Trzecia' },
        ).expect(429);
        expect(blocked.body).toMatchObject({ code: 'AI_QUOTA_EXCEEDED' });
      } finally {
        delete process.env.AI_LIMIT_MESSAGES_PER_MONTH;
      }
    });

    it('AI_ENABLED=false: 503 AI_DISABLED, ale kasowanie rozmów działa', async () => {
      process.env.AI_ENABLED = 'false';
      try {
        const res = await request(app.getHttpServer())
          .get('/agent/conversations')
          .set(auth(session.accessToken))
          .expect(503);
        expect(res.body).toMatchObject({ code: 'AI_DISABLED' });

        // RODO nie może zależeć od flagi wdrożeniowej.
        const removed = await request(app.getHttpServer())
          .delete('/agent/conversations')
          .set(auth(session.accessToken))
          .expect(200);
        expect(removed.body.deleted).toBeGreaterThan(0);
      } finally {
        process.env.AI_ENABLED = 'true';
      }
    });

    it('po skasowaniu nie ma już rozmów', async () => {
      const res = await request(app.getHttpServer())
        .get('/agent/conversations')
        .set(auth(session.accessToken))
        .expect(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('metryki', () => {
    it('/ops/metrics ma sekcję `agent` z policzonymi turami', async () => {
      const res = await request(app.getHttpServer())
        .get('/ops/metrics')
        .set(opsHeaders())
        .expect(200);

      const agent = (
        res.body as {
          agent: {
            turns: { started: number; done: number; failed: number };
            rejected: { quota: number; inProgress: number; disabled: number };
            usage: { providerCalls: number };
          };
        }
      ).agent;

      expect(agent.turns.started).toBeGreaterThan(0);
      expect(agent.turns.done).toBeGreaterThan(0);
      expect(agent.turns.failed).toBeGreaterThan(0);
      expect(agent.rejected.quota).toBeGreaterThan(0);
      expect(agent.rejected.inProgress).toBeGreaterThan(0);
      expect(agent.rejected.disabled).toBeGreaterThan(0);
      expect(agent.usage.providerCalls).toBeGreaterThan(0);
    });
  });
});
