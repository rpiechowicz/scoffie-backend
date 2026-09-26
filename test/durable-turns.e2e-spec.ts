import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { CARDS_CAPABILITY_V1 } from '../src/agent/cards/agent-cards';
import { AgentTurnRunner } from '../src/agent/agent-turn.runner';
import { AgentTurnSweeper } from '../src/agent/agent-turn-sweeper.service';
import { AgentTurnWorker } from '../src/agent/durable/agent-turn-worker.service';
import { AgentTurnQueue } from '../src/agent/durable/agent-turn-queue.service';
import { AgentUsageLedger } from '../src/agent/agent-usage-ledger.service';
import { readAgentEnv } from '../src/config/agent-env';

/**
 * Trwałe wykonywanie tur (workstream, Etap 5) na żywej bazie, bez modelu.
 *
 * „Proces" to osobna instancja CAŁEJ aplikacji Nest (`AppModule`) — własny
 * runner, worker, mapy w pamięci i pula połączeń. Pad procesu (SIGKILL) to
 * `runner.vanishForTests()` + zatrzymany worker: tura przerywa się bez
 * ANI JEDNEGO zapisu, dokładnie tak, jak zostaje w bazie po nagłej śmierci.
 * Odzyskanie robi DRUGA instancja (`survivor`), która nie ma w pamięci nic
 * z pierwszej — wszystko, co wie, bierze z bazy.
 *
 * Wygaśnięcie lease przyspieszamy zapisem w bazie (`leaseExpiresAt` w
 * przeszłości) zamiast czekać 60 s; odpytywanie workera wołamy jawnie.
 */
type Session = {
  accessToken: string;
  user: { id: string };
  household: { id: string } | null;
};

const WEEK_START = '2026-08-31';
const CLIENT_TODAY = '2026-09-02';

jest.setTimeout(90_000);

describe('Trwałe tury asystenta E2E (Etap 5)', () => {
  let survivor: NestExpressApplication;
  let prisma: PrismaService;
  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];
  const spawned: NestExpressApplication[] = [];

  const ENV = {
    AI_ENABLED: 'true',
    AI_PROVIDER: 'stub',
    AI_STUB_DELAY_MS: '0',
    AI_TIER_OVERRIDE: 'PRO',
    AI_CONSENT_REQUIRED: 'false',
    AI_CARDS_MODE: 'soft',
    AI_MAX_CONCURRENT_TURNS_PER_HOUSEHOLD: '5',
    AI_HOUSEHOLD_DAILY_COST_USD: 'off',
    AI_HOUSEHOLD_MONTHLY_COST_USD: 'off',
    AI_GLOBAL_DAILY_BUDGET_USD: 'off',
    AI_TURN_LEASE_MS: '60000',
    AI_TURN_MAX_ATTEMPTS: '3',
    AI_TURN_WORKER: 'on',
    // Odpytywanie wołamy jawnie — interwał nie może wejść testowi w drogę.
    AI_TURN_WORKER_POLL_MS: '600000',
    AI_SHUTDOWN_GRACE_MS: '8000',
    THROTTLE_DEFAULT_LIMIT: '10000',
    THROTTLE_IP_LIMIT: '10000',
    THROTTLE_AUTH_LIMIT: '10000',
    THROTTLE_AGENT_MESSAGE_LIMIT: '10000',
    THROTTLE_AGENT_POLL_LIMIT: '10000',
  } as const;
  const original: Record<string, string | undefined> = {};

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Nowy „proces": osobna instancja aplikacji na tej samej bazie. */
  const spawn = async (): Promise<NestExpressApplication> => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    spawned.push(app);
    return app;
  };

  /** SIGKILL: pamięć procesu przestaje istnieć, w bazie zostaje to, co było. */
  const kill = async (app: NestExpressApplication) => {
    app.get(AgentTurnWorker).stop();
    app.get(AgentTurnRunner).vanishForTests();
    // Pętla zdarzeń domyka przerwane obietnice (bez zapisów).
    await sleep(50);
  };

  const expireLease = (turnId: string) =>
    prisma.$executeRaw`
      UPDATE "AgentTurn" SET "leaseExpiresAt" = now() - interval '1 second'
      WHERE id = ${turnId}::uuid`;

  const household = async (label: string) => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const res = await request(survivor.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `${label} ${stamp}`,
        email: `durable-${stamp}@durable.local`,
      })
      .expect(201);
    const session = res.body as Session;
    createdUserIds.push(session.user.id);
    if (session.household) createdHouseholdIds.push(session.household.id);
    const home = await prisma.household.create({
      data: { name: `${label} ${stamp}`, createdById: session.user.id },
    });
    await prisma.membership.create({
      data: { userId: session.user.id, householdId: home.id, role: 'OWNER' },
    });
    createdHouseholdIds.push(home.id);
    const conversation = (
      await request(survivor.getHttpServer())
        .post('/agent/conversations')
        .set(auth(session.accessToken))
        .send({ householdId: home.id })
        .expect(201)
    ).body as { id: string };
    return { session, householdId: home.id, conversationId: conversation.id };
  };

  const post = async (
    app: NestExpressApplication,
    who: { session: Session; conversationId: string },
    text: string,
    cards = true,
  ): Promise<string> => {
    const accepted = await request(app.getHttpServer())
      .post(`/agent/conversations/${who.conversationId}/messages`)
      .set(auth(who.session.accessToken))
      .send({
        text,
        clientMessageId: randomUUID(),
        weekStart: WEEK_START,
        clientToday: CLIENT_TODAY,
        timeZone: 'Europe/Warsaw',
        ...(cards ? { clientCapabilities: [CARDS_CAPABILITY_V1] } : {}),
      })
      .expect(202);
    return (accepted.body as { turnId: string }).turnId;
  };

  const turnRow = (turnId: string) =>
    prisma.agentTurn.findUniqueOrThrow({ where: { id: turnId } });

  const waitFor = async <T>(
    what: string,
    probe: () => Promise<T | null | undefined | false>,
    timeoutMs = 15_000,
  ): Promise<T> => {
    for (const deadline = Date.now() + timeoutMs; ; ) {
      const value = await probe();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`nie doczekano: ${what}`);
      await sleep(50);
    }
  };

  const waitClosed = (turnId: string) =>
    waitFor(`domknięcia tury ${turnId}`, async () => {
      const row = await turnRow(turnId);
      return row.status !== 'RUNNING' ? row : null;
    });

  const waitClaimed = (turnId: string, attempt = 1) =>
    waitFor(`przejęcia tury ${turnId}`, async () => {
      const row = await turnRow(turnId);
      return row.attempt >= attempt && row.leaseToken ? row : null;
    });

  const waitEffect = (turnId: string, key: string) =>
    waitFor(`efektu ${key}`, () =>
      prisma.agentTurnEffect.findUnique({
        where: { turnId_key: { turnId, key } },
      }),
    );

  const answers = (turnId: string) =>
    prisma.agentMessage.findMany({ where: { turnId, role: 'ASSISTANT' } });

  const usageRows = (turnId: string) =>
    prisma.aiUsage.findMany({
      where: { callKey: { startsWith: `turn:${turnId}:` } },
      orderBy: { callKey: 'asc' },
    });

  const messagesCounter = async (scopeId: string) =>
    (
      await prisma.aiUsageCounter.findMany({
        where: { scopeId, kind: 'messages' },
      })
    ).reduce((sum, row) => sum + row.value, 0);

  const catalogDinner = () =>
    prisma.recipe.findFirstOrThrow({
      where: {
        isCatalog: true,
        isActive: true,
        suitableMealTypes: { has: 'DINNER' },
        allergens: { isEmpty: true },
      },
      orderBy: { id: 'asc' },
      select: { id: true },
    });

  const worker = (app: NestExpressApplication) => app.get(AgentTurnWorker);

  beforeAll(async () => {
    for (const [key, value] of Object.entries(ENV)) {
      original[key] = process.env[key];
      process.env[key] = value;
    }
    survivor = await spawn();
    prisma = survivor.get(PrismaService);
  });

  afterEach(async () => {
    process.env.AI_STUB_DELAY_MS = '0';
    process.env.AI_TURN_WORKER = 'on';
    process.env.AI_SHUTDOWN_GRACE_MS = '8000';
    // „Procesy" jednego testu — survivor żyje do końca.
    for (const app of spawned.splice(1)) {
      await kill(app);
      await app.close();
    }
  });

  afterAll(async () => {
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
    for (const key of Object.keys(ENV)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    await survivor.close();
  });

  it('1. (§5.14) proces przyjmuje wiadomość i pada PRZED startem runnera → druga instancja kończy turę', async () => {
    const who = await household('Przyjecie');
    const doomed = await spawn();
    process.env.AI_TURN_WORKER = 'off'; // proces przyjmuje, ale nie wykonuje
    const turnId = await post(doomed, who, 'Co na obiad?');
    await kill(doomed);

    const accepted = await turnRow(turnId);
    expect(accepted).toMatchObject({ status: 'RUNNING', attempt: 0 });
    expect(accepted.execution).toMatchObject({
      dates: { weekStart: WEEK_START, clientToday: CLIENT_TODAY },
    });
    expect(accepted.deadlineAt).toBeInstanceOf(Date);

    process.env.AI_TURN_WORKER = 'on';
    expect(await worker(survivor).poll()).toBeGreaterThanOrEqual(1);
    const done = await waitClosed(turnId);
    expect(done).toMatchObject({ status: 'DONE', attempt: 1 });
    expect(await answers(turnId)).toHaveLength(1);
  });

  it('2. (§5.2) 20 workerów przejmuje tę samą turę równocześnie → dokładnie jeden właściciel', async () => {
    const who = await household('Claim20');
    process.env.AI_TURN_WORKER = 'off';
    const turnId = await post(survivor, who, 'Wyścig');
    process.env.AI_TURN_WORKER = 'on';
    const queue = survivor.get(AgentTurnQueue);

    const claims = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        queue.claim({
          workerId: `rywal-${index}`,
          leaseMs: 60_000,
          maxAttempts: 3,
          limit: 1,
          turnId,
        }),
      ),
    );
    const winners = claims.flat();
    expect(winners).toHaveLength(1);
    const row = await turnRow(turnId);
    expect(row.attempt).toBe(1);
    expect(row.leaseToken).toBe(winners[0].leaseToken);
    expect(row.leaseOwner).toMatch(/^rywal-/);

    // Sprzątanie: nikt nie prowadzi tej tury naprawdę.
    await prisma.agentTurn.update({
      where: { id: turnId },
      data: { status: 'FAILED', errorCode: 'AI_CANCELLED' },
    });
  });

  it('3. (§5.3) worker A traci lease, B przejmuje; A „odżywa" i kończy — fencing blokuje A', async () => {
    const who = await household('Fencing');
    const zombie = await spawn();
    process.env.AI_STUB_DELAY_MS = '1500';
    const turnId = await post(zombie, who, 'Plan na jutro');
    const first = await waitClaimed(turnId, 1);
    // A jest już w wywołaniu „modelu" (1,5 s); B dostanie dłuższe (4 s).
    await sleep(700);

    await expireLease(turnId);
    process.env.AI_STUB_DELAY_MS = '4000';
    expect(await worker(survivor).poll()).toBeGreaterThanOrEqual(1);
    const second = await waitClaimed(turnId, 2);
    expect(second.leaseToken).not.toBe(first.leaseToken);

    // A dojeżdża pierwszy — wywołanie zapłacone (księga), ale jego DONE nie
    // ma prawa się zapisać: tura dalej należy do B.
    await waitFor('końca próby A', async () =>
      (await usageRows(turnId)).some(
        (row) => row.callKey === `turn:${turnId}:0`,
      )
        ? true
        : null,
    );
    await sleep(200);
    expect((await turnRow(turnId)).status).toBe('RUNNING');
    expect(await answers(turnId)).toHaveLength(0);

    const done = await waitClosed(turnId);
    expect(done).toMatchObject({ status: 'DONE', attempt: 2 });
    expect(await answers(turnId)).toHaveLength(1);
    // Koszt OBU prób zostaje — każde realne wywołanie pod własnym kluczem.
    expect((await usageRows(turnId)).map((row) => row.callKey)).toEqual([
      `turn:${turnId}:0`,
      `turn:${turnId}:a2:0`,
    ]);
  });

  it('4./5./6./11. (§5.8, §5.18) PRAWDZIWY RESTART: pad po pierwszym wywołaniu z zapisanym kosztem → nowa instancja kończy turę; koszt ani zgubiony, ani zdublowany', async () => {
    const who = await household('Restart');
    const doomed = await spawn();
    process.env.AI_STUB_DELAY_MS = '10000';
    const turnId = await post(doomed, who, 'Ułóż kolację [[cost:7000]]');
    await waitFor('kosztu pierwszego wywołania', async () =>
      (await usageRows(turnId)).length === 1 ? true : null,
    );
    await kill(doomed);

    // Lease wygasł PRZED terminem tury → odzyskanie, nie timeout (§5.11).
    await expireLease(turnId);
    process.env.AI_STUB_DELAY_MS = '0';
    // Nowy proces przejmuje porzuconą turę SAM, przy starcie (§5.5) — bez
    // telefonu i bez czekania na odpytywanie.
    const heir = await spawn();
    const done = await waitClosed(turnId);
    expect(done).toMatchObject({
      status: 'DONE',
      attempt: 2,
      errorCode: null,
      leaseOwner: worker(heir).id,
    });
    expect(await answers(turnId)).toHaveLength(1);

    const rows = await usageRows(turnId);
    // Próba 1: wywołanie 0 (7000 µ$), zapisane przed padem — zostaje.
    // Próba 2: NOWE realne wywołania — nowe klucze (a2), nie „duplikat".
    expect(
      rows.map((row) => [row.callKey, row.costMicroUsd, row.attempt]),
    ).toEqual([
      [`turn:${turnId}:0`, 7000, 1],
      [`turn:${turnId}:a2:0`, 7000, 2],
      [`turn:${turnId}:a2:1`, 0, 2],
    ]);
    expect(done.costMicroUsd).toBe(14_000);

    // 6. Ponowiony zapis TEGO SAMEGO znanego wywołania — dokładnie raz.
    const ledger = heir.get(AgentUsageLedger);
    const same = {
      turnId,
      userId: who.session.user.id,
      householdId: who.householdId,
      provider: 'stub',
      attempt: 2,
      env: readAgentEnv(),
    };
    const call = {
      callIndex: 0,
      model: 'stub',
      effort: 'low' as const,
      usage: {
        inputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 1,
        costMicroUsd: 7000,
      },
      stopReason: 'end_turn',
      latencyMs: 0,
    };
    await ledger.record(same, call);
    await ledger.record(same, call);
    expect(await usageRows(turnId)).toHaveLength(3);
    expect((await turnRow(turnId)).costMicroUsd).toBe(14_000);
  });

  it('7. (§5.7) pad po utworzeniu propozycji → odzyskanie bez drugiej propozycji i bez wywołania modelu', async () => {
    const who = await household('Propozycja');
    const recipe = await catalogDinner();
    const doomed = await spawn();
    process.env.AI_STUB_DELAY_MS = '10000';
    const turnId = await post(
      doomed,
      who,
      `Zaproponuj kolację [[propose:${recipe.id}:${WEEK_START}]] [[hold]]`,
    );
    await waitEffect(turnId, 'card');
    await kill(doomed);
    expect(await prisma.agentProposal.count({ where: { turnId } })).toBe(1);

    await expireLease(turnId);
    await worker(survivor).poll();
    const done = await waitClosed(turnId);
    expect(done).toMatchObject({ status: 'DONE', attempt: 2 });

    const proposals = await prisma.agentProposal.findMany({
      where: { turnId },
    });
    expect(proposals).toHaveLength(1);
    const [answer] = await answers(turnId);
    expect(answer.kind).toBe('PLAN_WEEK');
    expect(proposals[0].messageId).toBe(answer.id);
    // Zdanie serwera z karty — tura domknięta bez modelu.
    expect(answer.text).toBe('Propozycja czeka na zatwierdzenie.');
    expect(
      (await usageRows(turnId)).filter((row) => row.attempt === 2),
    ).toHaveLength(0);
  });

  it('8. (§5.7) pad 1 ms po COMMIT narzędzia z efektem (notatka) → odzyskanie nie tworzy drugiej', async () => {
    const who = await household('Notatka');
    const text = `Lubimy pikantne ${randomUUID().slice(0, 8)}`;
    const doomed = await spawn();
    process.env.AI_STUB_DELAY_MS = '10000';
    const turnId = await post(
      doomed,
      who,
      `Zapamiętaj [[note:${text}]] [[hold]]`,
    );
    await waitEffect(turnId, 'remember_note#1');
    await kill(doomed);

    await expireLease(turnId);
    process.env.AI_STUB_DELAY_MS = '0';
    await worker(survivor).poll();
    expect(await waitClosed(turnId)).toMatchObject({
      status: 'DONE',
      attempt: 2,
    });

    expect(
      await prisma.agentMemory.count({
        where: { householdId: who.householdId, text },
      }),
    ).toBe(1);
    const effects = await prisma.agentTurnEffect.findMany({
      where: { turnId },
    });
    expect(effects.map((row) => [row.key, row.attempt])).toEqual([
      ['remember_note#1', 1],
    ]);
    expect(await answers(turnId)).toHaveLength(1);
  });

  it('8b. (§5.7) zapis planu (tryb bez kart) → odzyskanie nie zapisuje drugi raz i nie zjada drugiej kwoty planu', async () => {
    const who = await household('ZapisPlanu');
    const recipe = await catalogDinner();
    const doomed = await spawn();
    process.env.AI_STUB_DELAY_MS = '10000';
    const turnId = await post(
      doomed,
      who,
      `Zapisz kolację [[apply:${recipe.id}:${WEEK_START}]] [[hold]]`,
      false,
    );
    await waitEffect(turnId, 'apply_week_plan#1');
    await kill(doomed);

    await expireLease(turnId);
    process.env.AI_STUB_DELAY_MS = '0';
    await worker(survivor).poll();
    expect(await waitClosed(turnId)).toMatchObject({ status: 'DONE' });

    const items = await prisma.planItem.findMany({
      where: {
        weeklyPlan: { householdId: who.householdId },
        dayOfWeek: 'TUE',
        mealType: 'DINNER',
      },
    });
    expect(items).toHaveLength(1);
    const plans = await prisma.aiUsageCounter.findMany({
      where: { kind: 'plans', scopeId: who.householdId },
    });
    expect(plans.reduce((sum, row) => sum + row.value, 0)).toBe(1);
  });

  it('9. (§5.9) odpowiedź tury już jest, tura wciąż RUNNING → odzyskanie domyka TĘ turę bez drugiej odpowiedzi', async () => {
    const who = await household('Odpowiedz');
    process.env.AI_TURN_WORKER = 'off';
    const turnId = await post(survivor, who, 'Hej');
    // Stan „odpowiedź zapisana, status nie" (np. inny kod, ręczna naprawa).
    const existing = await prisma.agentMessage.create({
      data: {
        conversationId: who.conversationId,
        role: 'ASSISTANT',
        text: 'Odpowiedź sprzed padu',
        turnId,
        outputKey: 'final',
      },
    });
    process.env.AI_TURN_WORKER = 'on';
    await worker(survivor).poll();
    expect(await waitClosed(turnId)).toMatchObject({ status: 'DONE' });
    const all = await answers(turnId);
    expect(all.map((row) => row.id)).toEqual([existing.id]);
  });

  it('10. (§5.10) „Stop" → pad procesu → odzyskanie: tura zostaje anulowana, nikt jej nie kontynuuje', async () => {
    const who = await household('StopPad');
    const doomed = await spawn();
    process.env.AI_STUB_DELAY_MS = '10000';
    const turnId = await post(doomed, who, 'Długa tura');
    await waitClaimed(turnId, 1);
    await kill(doomed);

    // Telefon trafia już w drugą instancję; lease padniętej jeszcze żyje.
    const stop = await request(survivor.getHttpServer())
      .post(`/agent/turns/${turnId}/cancel`)
      .set(auth(who.session.accessToken))
      .expect(200);
    expect(stop.body).toMatchObject({ status: 'RUNNING', stopRequested: true });
    expect((await turnRow(turnId)).cancelRequestedAt).toBeInstanceOf(Date);

    await expireLease(turnId);
    expect(await worker(survivor).poll()).toBe(0);
    await survivor.get(AgentTurnSweeper).sweep();
    const closed = await turnRow(turnId);
    expect(closed).toMatchObject({
      status: 'FAILED',
      errorCode: 'AI_CANCELLED',
      failureDetail: 'AI_TURN_CANCEL_REQUESTED',
      attempt: 1,
    });
    expect(await answers(turnId)).toHaveLength(0);
  });

  it('12. (§5.11) termin tury minął → AI_TIMEOUT, bez kolejnej próby', async () => {
    const who = await household('Termin');
    const doomed = await spawn();
    process.env.AI_STUB_DELAY_MS = '10000';
    const turnId = await post(doomed, who, 'Za długo');
    await waitClaimed(turnId, 1);
    await kill(doomed);
    await prisma.$executeRaw`
      UPDATE "AgentTurn"
         SET "leaseExpiresAt" = now() - interval '1 second',
             "deadlineAt" = now() - interval '10 seconds'
       WHERE id = ${turnId}::uuid`;

    expect(await worker(survivor).poll()).toBe(0);
    await survivor.get(AgentTurnSweeper).sweep();
    expect(await turnRow(turnId)).toMatchObject({
      status: 'FAILED',
      errorCode: 'AI_TIMEOUT',
      attempt: 1,
    });
  });

  it('13./16. (§5.12) wyczerpane próby → kontrolowany FAILED; koszt 0 → zwrot wiadomości', async () => {
    const who = await household('Proby');
    const doomed = await spawn();
    process.env.AI_STUB_DELAY_MS = '10000';
    const turnId = await post(doomed, who, 'Pętla deployów');
    await waitClaimed(turnId, 1);
    await kill(doomed);
    expect(await messagesCounter(who.householdId)).toBe(1);
    await prisma.$executeRaw`
      UPDATE "AgentTurn"
         SET "leaseExpiresAt" = now() - interval '1 second', "attempt" = 3
       WHERE id = ${turnId}::uuid`;

    expect(await worker(survivor).poll()).toBe(0);
    await survivor.get(AgentTurnSweeper).sweep();
    const closed = await turnRow(turnId);
    expect(closed).toMatchObject({
      status: 'FAILED',
      errorCode: 'AI_PROVIDER_ERROR',
      failureDetail: 'AI_TURN_ATTEMPTS_EXHAUSTED',
      quotaRefunded: true,
    });
    expect(await messagesCounter(who.householdId)).toBe(0);
  });

  it('16. koszt > 0 w przerwanej próbie → wyczerpane próby BEZ zwrotu, koszt w księdze', async () => {
    const who = await household('ProbyKoszt');
    const doomed = await spawn();
    process.env.AI_STUB_DELAY_MS = '10000';
    const turnId = await post(doomed, who, 'Drogo [[cost:5000]]');
    await waitFor('kosztu', async () =>
      (await usageRows(turnId)).length === 1 ? true : null,
    );
    await kill(doomed);
    await prisma.$executeRaw`
      UPDATE "AgentTurn"
         SET "leaseExpiresAt" = now() - interval '1 second', "attempt" = 3
       WHERE id = ${turnId}::uuid`;
    await survivor.get(AgentTurnSweeper).sweep();
    const closed = await turnRow(turnId);
    expect(closed).toMatchObject({
      status: 'FAILED',
      quotaRefunded: false,
      costMicroUsd: 5000,
    });
    expect(await messagesCounter(who.householdId)).toBe(1);
  });

  it('14. (§5.7) restart podczas kończącej turę karty `suggest_meals` → dokładnie jedna karta', async () => {
    const who = await household('Wybor');
    const doomed = await spawn();
    process.env.AI_STUB_DELAY_MS = '10000';
    const turnId = await post(
      doomed,
      who,
      'Co na kolację? [[suggest:TUE:DINNER:-]] [[hold]]',
    );
    const effect = await waitEffect(turnId, 'card');
    expect(effect.tool).toBe('suggest_meals');
    await kill(doomed);

    await expireLease(turnId);
    await worker(survivor).poll();
    expect(await waitClosed(turnId)).toMatchObject({
      status: 'DONE',
      attempt: 2,
    });
    const all = await answers(turnId);
    expect(all).toHaveLength(1);
    expect(all[0].kind).toBe('OPTIONS');
    expect(all[0].card).toEqual(effect.card);
  });

  it('15. (§5.7) restart podczas `build_meal_plan` → plan/propozycja się nie dubluje', async () => {
    const who = await household('Planista');
    const doomed = await spawn();
    process.env.AI_STUB_DELAY_MS = '10000';
    const turnId = await post(
      doomed,
      who,
      `Zaplanuj wtorek [[build:${WEEK_START}:TUE]] [[hold]]`,
    );
    await waitEffect(turnId, 'card');
    await kill(doomed);

    await expireLease(turnId);
    process.env.AI_STUB_DELAY_MS = '0';
    await worker(survivor).poll();
    expect(await waitClosed(turnId)).toMatchObject({ status: 'DONE' });
    const proposals = await prisma.agentProposal.findMany({
      where: { turnId },
    });
    expect(proposals).toHaveLength(1);
    const all = await answers(turnId);
    expect(all).toHaveLength(1);
    expect(proposals[0].messageId).toBe(all[0].id);
  });

  it('17. (§5.17) rozmowa skasowana (RODO) w trakcie odzyskiwania → księga zostaje, worker nie wskrzesza rozmowy', async () => {
    const who = await household('Rodo');
    const doomed = await spawn();
    process.env.AI_STUB_DELAY_MS = '10000';
    const turnId = await post(doomed, who, 'Do skasowania [[cost:3000]]');
    await waitFor('kosztu', async () =>
      (await usageRows(turnId)).length === 1 ? true : null,
    );
    await kill(doomed);
    await request(survivor.getHttpServer())
      .delete(`/agent/conversations/${who.conversationId}`)
      .set(auth(who.session.accessToken))
      .expect((res) => {
        if (res.status >= 300) throw new Error(`DELETE ${res.status}`);
      });

    expect(await worker(survivor).poll()).toBe(0);
    expect(
      await prisma.agentTurn.findUnique({ where: { id: turnId } }),
    ).toBeNull();
    const [row] = await usageRows(turnId);
    expect(row).toMatchObject({ turnId: null, costMicroUsd: 3000 });
    expect(
      await prisma.agentMessage.count({
        where: { conversationId: who.conversationId },
      }),
    ).toBe(0);
  });

  it('18. (§5.15) zamykanie procesu: nowe przejęcia zatrzymane, lease oddany — druga instancja przejmuje od razu', async () => {
    const who = await household('Deploy');
    const leaving = await spawn();
    process.env.AI_STUB_DELAY_MS = '10000';
    process.env.AI_SHUTDOWN_GRACE_MS = '100';
    const turnId = await post(leaving, who, 'W trakcie deployu');
    await waitClaimed(turnId, 1);

    // SIGTERM: łaska minęła, tura nieskończona — lease wraca do kolejki.
    await leaving.get(AgentTurnRunner).beforeApplicationShutdown();
    expect(await worker(leaving).poll()).toBe(0);
    const released = await turnRow(turnId);
    expect(released).toMatchObject({
      status: 'RUNNING',
      leaseToken: null,
      leaseExpiresAt: null,
      attempt: 1,
    });

    process.env.AI_STUB_DELAY_MS = '0';
    expect(await worker(survivor).poll()).toBeGreaterThanOrEqual(1);
    expect(await waitClosed(turnId)).toMatchObject({
      status: 'DONE',
      attempt: 2,
    });
    expect(await answers(turnId)).toHaveLength(1);
  });

  it('metryki kolejki: przejęcia i odzyskania w /ops/metrics', async () => {
    const res = await request(survivor.getHttpServer())
      .get('/ops/metrics')
      .set(
        process.env.OPS_TOKEN ? { 'x-ops-token': process.env.OPS_TOKEN } : {},
      )
      .expect(200);
    const jobs = (res.body as { agent: { jobs: Record<string, number> } }).agent
      .jobs;
    expect(jobs.attempts).toBeGreaterThan(0);
    expect(jobs.recovered).toBeGreaterThan(0);
  });
});
