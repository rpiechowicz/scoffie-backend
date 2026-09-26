import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { AiUsageCountersService } from '../src/agent/ai-usage-counters.service';
import { AgentUsageLedger } from '../src/agent/agent-usage-ledger.service';

/**
 * Księgowanie kosztu asystenta pod anulowaniem, timeoutem, restartem
 * i równoległymi startami (workstream, Etap 1) — na żywej bazie, z dostawcą
 * `stub` i markerem kosztu `[[cost:N]]`.
 *
 * Każdy przypadek jest opisem błędu sprzed poprawki:
 * - tura domknięta Z ZEWNĄTRZ (leniwy timeout z odczytu, „Stop") gubiła
 *   koszt, który dostawca już naliczył, i oddawała wiadomość mimo wydanych
 *   pieniędzy;
 * - tura osierocona przez restart procesu blokowała rozmowę ~4 minuty;
 * - dwa równoległe starty tego samego domu przechodziły przez sufit
 *   dobowy, bo sprawdzenie było tylko „przed startem" i nie widziało tur
 *   w biegu.
 */
type Session = {
  accessToken: string;
  user: { id: string };
  household: { id: string } | null;
};

const WEEK_START = '2026-08-31';
const CLIENT_TODAY = '2026-09-02';
const TIME_ZONE = 'Europe/Warsaw';

describe('Asystent: księgowanie kosztu E2E', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let counters: AiUsageCountersService;
  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];

  const ENV_KEYS = [
    'AI_ENABLED',
    'AI_PROVIDER',
    'AI_STUB_DELAY_MS',
    'AI_TIER_OVERRIDE',
    'AI_CONSENT_REQUIRED',
    'AI_MAX_CONCURRENT_TURNS_PER_HOUSEHOLD',
    'AI_HOUSEHOLD_DAILY_COST_USD',
    'AI_HOUSEHOLD_MONTHLY_COST_USD',
    'AI_GLOBAL_DAILY_BUDGET_USD',
    'AI_TURN_COST_RESERVE_USD',
    'THROTTLE_DEFAULT_LIMIT',
    'THROTTLE_IP_LIMIT',
    'THROTTLE_AGENT_MESSAGE_LIMIT',
    'THROTTLE_AGENT_POLL_LIMIT',
  ] as const;
  const original: Record<string, string | undefined> = {};

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  const devLogin = async (label: string): Promise<Session> => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `${label} ${stamp}`,
        email: `${label.toLowerCase()}-${stamp}@accounting.local`,
      })
      .expect(201);
    const session = res.body as Session;
    createdUserIds.push(session.user.id);
    if (session.household) createdHouseholdIds.push(session.household.id);
    return session;
  };

  /** Świeży dom na przypadek — liczniki kosztu jednego nie mieszają się z drugim. */
  const freshHousehold = async (label: string) => {
    const session = await devLogin(label);
    const household = await prisma.household.create({
      data: { name: `${label} ${Date.now()}`, createdById: session.user.id },
    });
    await prisma.membership.create({
      data: {
        userId: session.user.id,
        householdId: household.id,
        role: 'OWNER',
      },
    });
    createdHouseholdIds.push(household.id);
    return { session, householdId: household.id };
  };

  const createConversation = async (token: string, householdId: string) => {
    const res = await request(app.getHttpServer())
      .post('/agent/conversations')
      .set(auth(token))
      .send({ householdId })
      .expect(201);
    return (res.body as { id: string }).id;
  };

  const postMessage = (token: string, conversationId: string, text: string) =>
    request(app.getHttpServer())
      .post(`/agent/conversations/${conversationId}/messages`)
      .set(auth(token))
      .send({
        text,
        clientMessageId: randomUUID(),
        weekStart: WEEK_START,
        clientToday: CLIENT_TODAY,
        timeZone: TIME_ZONE,
      });

  const waitClosed = async (turnId: string, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = await prisma.agentTurn.findUniqueOrThrow({
        where: { id: turnId },
      });
      if (row.status !== 'RUNNING') return row;
      if (Date.now() > deadline) throw new Error(`tura ${turnId} wisi`);
      await sleep(100);
    }
  };

  const ledgerCost = async (turnId: string) =>
    (
      await prisma.aiUsage.aggregate({
        where: { turnId },
        _sum: { costMicroUsd: true },
      })
    )._sum.costMicroUsd ?? 0;

  const dayCost = (householdId: string) =>
    counters.read(householdId, counters.dayKey(), 'costMicroUsd');

  const messagesUsed = (householdId: string) =>
    counters.read(householdId, counters.monthKey(), 'messages');

  beforeAll(async () => {
    for (const key of ENV_KEYS) original[key] = process.env[key];
    process.env.AI_ENABLED = 'true';
    process.env.AI_PROVIDER = 'stub';
    process.env.AI_STUB_DELAY_MS = '0';
    process.env.AI_TIER_OVERRIDE = 'PRO';
    process.env.AI_CONSENT_REQUIRED = 'false';
    process.env.AI_MAX_CONCURRENT_TURNS_PER_HOUSEHOLD = '5';
    // Sufity wyłączone poza przypadkiem, który je testuje — licznik globalny
    // na wspólnej bazie dev rośnie z każdym przebiegiem.
    process.env.AI_HOUSEHOLD_DAILY_COST_USD = 'off';
    process.env.AI_HOUSEHOLD_MONTHLY_COST_USD = 'off';
    process.env.AI_GLOBAL_DAILY_BUDGET_USD = 'off';
    delete process.env.AI_TURN_COST_RESERVE_USD;
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
    counters = app.get(AiUsageCountersService);
  });

  afterAll(async () => {
    // Wiersze księgi po skasowanych rozmowach nie mają tury — po domu.
    await prisma.aiUsage.deleteMany({
      where: { householdId: { in: createdHouseholdIds } },
    });
    await prisma.aiUsageCounter.deleteMany({
      where: { scopeId: { in: createdHouseholdIds } },
    });
    await prisma.household.deleteMany({
      where: { id: { in: createdHouseholdIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    await app.close();
  });

  afterEach(() => {
    process.env.AI_STUB_DELAY_MS = '0';
    process.env.AI_HOUSEHOLD_DAILY_COST_USD = 'off';
    delete process.env.AI_TURN_COST_RESERVE_USD;
  });

  it('leniwy timeout z odczytu w trakcie tury: koszt zostaje w księdze, wiadomość nie wraca', async () => {
    const { session, householdId } = await freshHousehold('Timeout');
    const conversationId = await createConversation(
      session.accessToken,
      householdId,
    );
    process.env.AI_STUB_DELAY_MS = '1500';
    const accepted = await postMessage(
      session.accessToken,
      conversationId,
      'Ułóż tydzień [[cost:7000]]',
    ).expect(202);
    const turnId = (accepted.body as { turnId: string }).turnId;

    // Proces „wisi" dłużej niż sufit tury: odczyt uznaje turę za martwą.
    await sleep(300);
    await prisma.$executeRaw`
      UPDATE "AgentTurn"
         SET "startedAt" = now() - interval '10 minutes',
             "updatedAt" = now() - interval '10 minutes'
       WHERE id = ${turnId}::uuid`;
    const polled = await request(app.getHttpServer())
      .get(`/agent/turns/${turnId}`)
      .set(auth(session.accessToken))
      .expect(200);
    expect((polled.body as { status: string }).status).toBe('FAILED');

    // Dostawca kończy swoje wywołanie już po domknięciu tury.
    await sleep(2000);
    const turn = await prisma.agentTurn.findUniqueOrThrow({
      where: { id: turnId },
    });
    expect(await ledgerCost(turnId)).toBe(7000);
    expect(turn.costMicroUsd).toBe(7000);
    expect(await dayCost(householdId)).toBe(7000);
    // Pieniądze wydane — wiadomość nie wraca do puli.
    expect(turn.quotaRefunded).toBe(false);
    expect(await messagesUsed(householdId)).toBe(1);
  });

  it('„Stop" w trakcie tury: koszt zapisany dokładnie raz, bez zwrotu', async () => {
    const { session, householdId } = await freshHousehold('Stop');
    const conversationId = await createConversation(
      session.accessToken,
      householdId,
    );
    process.env.AI_STUB_DELAY_MS = '1500';
    const accepted = await postMessage(
      session.accessToken,
      conversationId,
      'Co na obiad? [[cost:9000]]',
    ).expect(202);
    const turnId = (accepted.body as { turnId: string }).turnId;

    await sleep(300);
    await request(app.getHttpServer())
      .post(`/agent/turns/${turnId}/cancel`)
      .set(auth(session.accessToken))
      .expect(200);
    const turn = await waitClosed(turnId);
    await sleep(1800);

    expect(turn.errorCode).toBe('AI_CANCELLED');
    expect(await ledgerCost(turnId)).toBe(9000);
    expect(await dayCost(householdId)).toBe(9000);
    expect(
      (await prisma.agentTurn.findUniqueOrThrow({ where: { id: turnId } }))
        .quotaRefunded,
    ).toBe(false);
  });

  it('tura bez kosztu przerwana „Stop": wiadomość wraca', async () => {
    const { session, householdId } = await freshHousehold('StopFree');
    const conversationId = await createConversation(
      session.accessToken,
      householdId,
    );
    process.env.AI_STUB_DELAY_MS = '1500';
    const accepted = await postMessage(
      session.accessToken,
      conversationId,
      'Co na obiad?',
    ).expect(202);
    const turnId = (accepted.body as { turnId: string }).turnId;
    await sleep(300);
    await request(app.getHttpServer())
      .post(`/agent/turns/${turnId}/cancel`)
      .set(auth(session.accessToken))
      .expect(200);
    await waitClosed(turnId);
    await sleep(1800);
    expect(
      (await prisma.agentTurn.findUniqueOrThrow({ where: { id: turnId } }))
        .quotaRefunded,
    ).toBe(true);
    expect(await messagesUsed(householdId)).toBe(0);
  });

  it('restart procesu: osierocona tura nie blokuje rozmowy do timeoutu', async () => {
    const { session, householdId } = await freshHousehold('Restart');
    const conversationId = await createConversation(
      session.accessToken,
      householdId,
    );
    // Stan po padzie procesu 90 s temu: tura RUNNING, ostatni znak życia
    // 90 s temu, dostawca zdążył naliczyć koszt jednego wywołania.
    const question = await prisma.agentMessage.create({
      data: { conversationId, role: 'USER', text: 'przed restartem' },
    });
    const orphan = await prisma.agentTurn.create({
      data: {
        conversationId,
        userId: session.user.id,
        userMessageId: question.id,
        requestId: 'przed-restartem',
        quotaScopeId: householdId,
        quotaPeriodKey: counters.monthKey(),
        costMicroUsd: 3000,
      },
    });
    await prisma.$executeRaw`
      UPDATE "AgentTurn"
         SET "startedAt" = now() - interval '90 seconds',
             "updatedAt" = now() - interval '90 seconds'
       WHERE id = ${orphan.id}::uuid`;

    await postMessage(
      session.accessToken,
      conversationId,
      'po restarcie',
    ).expect(202);

    const closed = await prisma.agentTurn.findUniqueOrThrow({
      where: { id: orphan.id },
    });
    expect(closed.status).toBe('FAILED');
    // Koszt naliczony przed padem zostaje; wiadomość nie wraca.
    expect(closed.quotaRefunded).toBe(false);
  });

  /**
   * Idempotencja księgi po usunięciu tury (review Etapu 1). Rozmowa skasowana
   * w trakcie tury (ścieżka RODO) zabiera turę; koszt i tak ma zostać
   * w księdze — ale ponowienie tego samego zapisu nie może go naliczyć drugi
   * raz. Klucz `(turnId, callIndex)` przestaje wtedy działać: po usunięciu tury
   * oba pola są NULL, a w Postgresie NULL-e nie kolidują w indeksie unikalnym.
   */
  describe('idempotencja księgi po usunięciu tury', () => {
    const call = (costMicroUsd: number) => ({
      callIndex: 0,
      model: 'claude-sonnet-5',
      effort: 'medium' as const,
      usage: {
        inputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 5,
        costMicroUsd,
      },
      stopReason: 'tool_use',
      latencyMs: 1,
    });

    const orphanTurn = async (label: string) => {
      const { session, householdId } = await freshHousehold(label);
      const conversationId = await createConversation(
        session.accessToken,
        householdId,
      );
      const question = await prisma.agentMessage.create({
        data: { conversationId, role: 'USER', text: 'pytanie' },
      });
      const turn = await prisma.agentTurn.create({
        data: {
          conversationId,
          userId: session.user.id,
          userMessageId: question.id,
          requestId: `ledger-${label}`,
          quotaScopeId: householdId,
          quotaPeriodKey: counters.monthKey(),
        },
      });
      const ledgerTurn = {
        turnId: turn.id,
        userId: session.user.id,
        householdId,
        provider: 'stub',
        env: {
          householdDailyCostUsd: null,
          householdMonthlyCostUsd: null,
          globalDailyBudgetUsd: null,
        },
      };
      // RODO: skasowanie rozmowy zabiera turę (kaskada), wiersze księgi
      // zostają z `turnId = NULL`.
      const erase = () =>
        prisma.agentConversation.delete({ where: { id: conversationId } });
      return { householdId, ledgerTurn, erase };
    };

    const householdLedger = async (householdId: string) => ({
      rows: await prisma.aiUsage.count({ where: { householdId } }),
      cost:
        (
          await prisma.aiUsage.aggregate({
            where: { householdId },
            _sum: { costMicroUsd: true },
          })
        )._sum.costMicroUsd ?? 0,
      day: await dayCost(householdId),
    });

    it('tura usunięta przed zapisem: ponowienie nie dubluje kosztu', async () => {
      const { householdId, ledgerTurn, erase } = await orphanTurn('LedgerA');
      await erase();
      const ledger = app.get(AgentUsageLedger);
      await ledger.record(ledgerTurn, call(5000));
      await ledger.record(ledgerTurn, call(5000));
      expect(await householdLedger(householdId)).toEqual({
        rows: 1,
        cost: 5000,
        day: 5000,
      });
    });

    it('zapis przy żywej turze, potem usunięcie i ponowienie: nadal jeden wiersz', async () => {
      const { householdId, ledgerTurn, erase } = await orphanTurn('LedgerB');
      const ledger = app.get(AgentUsageLedger);
      await ledger.record(ledgerTurn, call(4000));
      await erase();
      await ledger.record(ledgerTurn, call(4000));
      expect(await householdLedger(householdId)).toEqual({
        rows: 1,
        cost: 4000,
        day: 4000,
      });
    });
  });

  it('dwa równoległe starty jednego domu nie przechodzą przez dobowy sufit', async () => {
    const { session, householdId } = await freshHousehold('Budzet');
    const [first, second] = await Promise.all([
      createConversation(session.accessToken, householdId),
      createConversation(session.accessToken, householdId),
    ]);
    // Wydane 0,80 $ z 1,00 $; rezerwacja tury w biegu 0,30 $.
    process.env.AI_HOUSEHOLD_DAILY_COST_USD = '1';
    process.env.AI_TURN_COST_RESERVE_USD = '0.3';
    process.env.AI_STUB_DELAY_MS = '1500';
    await counters.add(
      prisma,
      householdId,
      counters.dayKey(),
      'costMicroUsd',
      800_000,
    );

    const responses = await Promise.all([
      postMessage(session.accessToken, first, 'pierwsza'),
      postMessage(session.accessToken, second, 'druga'),
    ]);
    const statuses = responses.map((res) => res.status).sort();
    expect(statuses).toEqual([202, 503]);
    const refused = responses.find((res) => res.status === 503);
    expect(refused?.body).toMatchObject({ code: 'AI_BUDGET_PAUSED' });

    // Po domknięciu tury rezerwacja znika — bez kosztu sufit znów wpuszcza.
    const accepted = responses.find((res) => res.status === 202);
    await waitClosed((accepted?.body as { turnId: string }).turnId);
    const conversation = accepted === responses[0] ? second : first;
    await postMessage(session.accessToken, conversation, 'trzecia').expect(202);
  });
});
