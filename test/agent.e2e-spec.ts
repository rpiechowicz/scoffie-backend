import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { STUB_TOOL_MARKER } from '../src/agent/providers/stub-agent.provider';
import { CARDS_CAPABILITY_V1 } from '../src/agent/cards/agent-cards';
import { AiUsageCountersService } from '../src/agent/ai-usage-counters.service';
import { WeeklyPlansService } from '../src/weekly-plans/weekly-plans.service';
import { lockWeekForWrite } from '../src/weekly-plans/utils/week-write-lock.util';
import { ShoppingListService } from '../src/weekly-plans/services/shopping-list.service';
import { HouseholdsService } from '../src/households/households.service';

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
  progress: { tool: string; label: string; at: string; writes: boolean }[];
  errorCode: string | null;
  messages?: { role: string; text: string; kind?: string; card?: unknown }[];
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
    'AI_TIER_OVERRIDE',
    'AI_LIMIT_MESSAGES_PER_MONTH',
    'AI_CARDS_MODE',
    'AI_ALLOWED_USERS',
    'AI_CONSENT_REQUIRED',
    'AI_MAX_CONCURRENT_TURNS_PER_HOUSEHOLD',
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
    // Bramka zgód jest od audytu 2 domyślnie włączona; ta suita testuje
    // ją w jednym miejscu, reszta przypadków ma dostać asystenta bez klikania.
    // PLAN JAWNIE, NIE Z DOMYŚLNEJ WARTOŚCI. Do 4.09.2026 brak
    // `AI_TIER_OVERRIDE` znaczył „PRO dla wszystkich", więc ta suita dostawała
    // pulę domu z miesiąca kalendarzowego, nie wiedząc o tym. Po zmianie
    // domyślnej wartości (skasowanie zmiennej w Railway rozdawało asystenta za
    // darmo) taki dom wpada na PRÓBĘ: pięć wiadomości i licznik w zakresie
    // `trial:<hasz>`, a nie `householdId`. Ta suita testuje asystenta, nie
    // paywall, więc mówi wprost, czego oczekuje.
    process.env.AI_TIER_OVERRIDE = 'PRO';
    process.env.AI_CONSENT_REQUIRED = 'false';
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

    it('konto spoza AI_ALLOWED_USERS: 503 AI_DISABLED z powodem not_allowed', async () => {
      // Lista czytana per wywołanie, jak reszta AI_* — bez restartu.
      process.env.AI_ALLOWED_USERS = 'ktos-inny@example.com';
      try {
        const res = await request(app.getHttpServer())
          .post('/agent/conversations')
          .set(auth(session.accessToken))
          .send({ householdId })
          .expect(503);
        expect(res.body).toMatchObject({
          code: 'AI_DISABLED',
          details: ['not_allowed'],
        });

        // Ten sam użytkownik na liście po id (wielkość liter i spacje obojętne).
        process.env.AI_ALLOWED_USERS = ` ${session.user.id.toUpperCase()} `;
        await request(app.getHttpServer())
          .post('/agent/conversations')
          .set(auth(session.accessToken))
          .send({ householdId })
          .expect(201);
      } finally {
        delete process.env.AI_ALLOWED_USERS;
      }
    });

    it('AI_CONSENT_REQUIRED: bez zgody 403, po POST /me/consents rozmowa rusza, po cofnięciu znów 403', async () => {
      process.env.AI_CONSENT_REQUIRED = 'true';
      try {
        const refused = await request(app.getHttpServer())
          .post('/agent/conversations')
          .set(auth(session.accessToken))
          .send({ householdId })
          .expect(403);
        expect(refused.body).toMatchObject({
          code: 'AI_CONSENT_REQUIRED',
          details: [
            'documentVersion:2026-09-23',
            'missing:AI_ASSISTANT',
            'missing:AGE_16',
          ],
        });

        // Stan zgód jest czytelny niezależnie od asystenta.
        const before = await request(app.getHttpServer())
          .get('/me/consents')
          .set(auth(session.accessToken))
          .expect(200);
        const aiBefore = (
          before.body as { kind: string; granted: boolean }[]
        ).find((entry) => entry.kind === 'AI_ASSISTANT');
        expect(aiBefore?.granted).toBe(false);

        const granted = await request(app.getHttpServer())
          .post('/me/consents')
          .set(auth(session.accessToken))
          .send({
            kind: 'AI_ASSISTANT',
            action: 'GRANTED',
            documentVersion: '2026-09-15',
            source: 'E2E',
          })
          .expect(201);
        expect(
          (granted.body as { kind: string; granted: boolean }[]).find(
            (entry) => entry.kind === 'AI_ASSISTANT',
          )?.granted,
        ).toBe(true);

        // Sama zgoda na asystenta nie wystarczy — bez deklaracji wieku
        // nadal 403, z wyliczeniem, czego brakuje.
        const stillRefused = await request(app.getHttpServer())
          .post('/agent/conversations')
          .set(auth(session.accessToken))
          .send({ householdId })
          .expect(403);
        expect(stillRefused.body.details).toEqual([
          'documentVersion:2026-09-23',
          'missing:AGE_16',
        ]);

        // Wersja z przyszłości nie ląduje w dzienniku.
        await request(app.getHttpServer())
          .post('/me/consents')
          .set(auth(session.accessToken))
          .send({
            kind: 'AGE_16',
            action: 'GRANTED',
            documentVersion: '2999-01-01',
          })
          .expect(400);

        await request(app.getHttpServer())
          .post('/me/consents')
          .set(auth(session.accessToken))
          .send({
            kind: 'AGE_16',
            action: 'GRANTED',
            documentVersion: '2026-09-15',
            source: 'E2E',
          })
          .expect(201);

        await request(app.getHttpServer())
          .post('/agent/conversations')
          .set(auth(session.accessToken))
          .send({ householdId })
          .expect(201);

        await request(app.getHttpServer())
          .post('/me/consents')
          .set(auth(session.accessToken))
          .send({
            kind: 'AI_ASSISTANT',
            action: 'REVOKED',
            documentVersion: '2026-09-15',
          })
          .expect(201);
        await request(app.getHttpServer())
          .post('/agent/conversations')
          .set(auth(session.accessToken))
          .send({ householdId })
          .expect(403);

        // Nieznany rodzaj zgody nie ląduje w dzienniku.
        await request(app.getHttpServer())
          .post('/me/consents')
          .set(auth(session.accessToken))
          .send({
            kind: 'NEWSLETTER',
            action: 'GRANTED',
            documentVersion: '2026-09-15',
          })
          .expect(400);
      } finally {
        process.env.AI_CONSENT_REQUIRED = 'false';
        await prisma.consentEvent.deleteMany({
          where: { userId: session.user.id },
        });
      }
    });

    it('„Zgłoś odpowiedź": własna odpowiedź asystenta 201, cudza/nieistniejąca 404', async () => {
      const conversation = await createConversation(
        session.accessToken,
        householdId,
      );
      const accepted = (
        await postMessage(session.accessToken, conversation.id, {
          clientMessageId: randomUUID(),
          text: 'Co na kolację?',
        }).expect(202)
      ).body as AcceptedTurn;
      const turn = await pollTurn(session.accessToken, accepted.turnId);
      const answer = turn.messages?.find((m) => m.role === 'ASSISTANT') as
        | { id?: string }
        | undefined;
      const messages = (
        await request(app.getHttpServer())
          .get(`/agent/conversations/${conversation.id}/messages`)
          .set(auth(session.accessToken))
          .expect(200)
      ).body.messages as { id: string; role: string }[];
      const assistantId =
        answer?.id ?? messages.find((m) => m.role === 'ASSISTANT')?.id;
      expect(assistantId).toBeDefined();

      const created = await request(app.getHttpServer())
        .post(`/agent/messages/${assistantId}/report`)
        .set(auth(session.accessToken))
        .send({ reason: 'WRONG', comment: 'To nie jest kolacja.' })
        .expect(201);
      expect(created.body).toMatchObject({ id: expect.any(String) });
      const stored = await prisma.agentReport.findUnique({
        where: { id: created.body.id as string },
      });
      expect(stored?.messageText.length).toBeGreaterThan(0);
      await prisma.agentReport.deleteMany({
        where: { userId: session.user.id },
      });

      // Własne pytanie nie jest odpowiedzią — 404, tak jak cudza wiadomość.
      const own = messages.find((m) => m.role === 'USER')?.id;
      await request(app.getHttpServer())
        .post(`/agent/messages/${own}/report`)
        .set(auth(session.accessToken))
        .send({ reason: 'OTHER' })
        .expect(404);
      await request(app.getHttpServer())
        .post(`/agent/messages/${randomUUID()}/report`)
        .set(auth(session.accessToken))
        .send({ reason: 'OTHER' })
        .expect(404);
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

      // Tytuł rozmowy bierze się z PIERWSZEJ wiadomości — bez tego lista
      // rozmów w telefonie to same daty.
      const list = await request(app.getHttpServer())
        .get('/agent/conversations')
        .set(auth(session.accessToken))
        .expect(200);
      const listed = (list.body as { id: string; title: string | null }[]).find(
        (item) => item.id === conversation.id,
      );
      expect(listed?.title).toBe('Co na obiad?');

      // Druga wiadomość NIE przemianowuje rozmowy — lista, która zmienia
      // nazwy pod palcami, jest nie do przeszukania.
      const second = await postMessage(session.accessToken, conversation.id, {
        clientMessageId: randomUUID(),
        text: 'A może jednak ryba?',
      }).expect(202);
      await pollTurn(session.accessToken, (second.body as AcceptedTurn).turnId);
      const listAgain = await request(app.getHttpServer())
        .get('/agent/conversations')
        .set(auth(session.accessToken))
        .expect(200);
      expect(
        (listAgain.body as { id: string; title: string | null }[]).find(
          (item) => item.id === conversation.id,
        )?.title,
      ).toBe('Co na obiad?');
    });

    it('wywołanie narzędzia zostawia ślad w `progress`, a nie pustą tablicę', async () => {
      const conversation = await createConversation(
        session.accessToken,
        householdId,
      );
      const accepted = await postMessage(session.accessToken, conversation.id, {
        clientMessageId: randomUUID(),
        text: `Sprawdź, kto je ${STUB_TOOL_MARKER}`,
      }).expect(202);

      const done = await pollTurn(
        session.accessToken,
        (accepted.body as AcceptedTurn).turnId,
      );
      expect(done.status).toBe('DONE');
      // Kolumna `progress` istniała od Fazy 0 i zawsze wracała pusta — klient
      // mógł pokazać wyłącznie kręciołek przez pół minuty.
      expect(done.progress).toEqual([
        {
          tool: 'get_household_context',
          label: expect.any(String),
          at: expect.any(String),
          // Odczyt — klient nie ma po tej turze czego otwierać.
          writes: false,
        },
      ]);
      // Etykieta jest gotowym zdaniem po polsku, nie kodem do tłumaczenia.
      expect(done.progress[0].label).not.toContain('_');
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

    /*
     * Testy RÓWNOLEGŁE — write skew, nie „drugie żądanie po pierwszym".
     *
     * Test wyżej wysyła drugą wiadomość, gdy pierwsza tura JEST JUŻ
     * zacommitowana, więc przechodzi także pod READ COMMITTED. Prawdziwy
     * wyścig wygląda inaczej: dwadzieścia żądań startuje RAZEM, każde robi
     * `count()` biegnących tur, żadne nie widzi niezacommitowanych wstawek
     * pozostałych i wszystkie liczą „zero biegnących". Dokładnie to zdarzenie
     * opisuje komentarz przy `runSerializable` w `agent-turns.service.ts` jako
     * powód, dla którego transakcja jest SERIALIZABLE.
     *
     * Z atrapą Prismy ten warunek nic nie znaczy — poziom izolacji istnieje
     * tylko w prawdziwym Postgresie. Stąd te dwa testy tutaj, a nie w unitach.
     */
    it('RÓWNOLEGLE: osiem żądań w jednej rozmowie — startuje dokładnie jedna tura', async () => {
      process.env.AI_STUB_DELAY_MS = '1500';
      try {
        const conversation = await createConversation(
          session.accessToken,
          householdId,
        );
        const before = await readQuota(householdId);

        // Bez `await` między żądaniami: wszystkie osiem wchodzi w transakcję
        // zanim którakolwiek zacommituje turę.
        const results = await Promise.all(
          Array.from({ length: 8 }, () =>
            postMessage(session.accessToken, conversation.id, {
              clientMessageId: randomUUID(),
              text: 'Równolegle',
            }),
          ),
        );

        const accepted = results.filter((res) => res.status === 202);
        const rejected = results.filter((res) => res.status === 409);
        expect(accepted).toHaveLength(1);
        expect(rejected).toHaveLength(7);
        for (const res of rejected) {
          expect(res.body).toMatchObject({ code: 'AI_TURN_IN_PROGRESS' });
        }

        // Stan w bazie, nie tylko kody odpowiedzi: odmowa musi wycofać CAŁĄ
        // transakcję, więc po siedmiu 409 nie ma ani wiersza tury, ani
        // wiadomości, ani zdjętej kwoty.
        const turns = await prisma.agentTurn.count({
          where: { conversationId: conversation.id },
        });
        expect(turns).toBe(1);
        const messages = await prisma.agentMessage.count({
          where: { conversationId: conversation.id, role: 'USER' },
        });
        expect(messages).toBe(1);
        expect(await readQuota(householdId)).toBe(before + 1);

        await pollTurn(
          session.accessToken,
          (accepted[0].body as AcceptedTurn).turnId,
        );
      } finally {
        process.env.AI_STUB_DELAY_MS = '0';
      }
    });

    it('RÓWNOLEGLE: sześć rozmów jednego domu — semafor przepuszcza najwyżej dwie', async () => {
      // To jest bramka na obejście budżetu dobowego, nie na wygodę: budżet
      // sprawdza się PRZED turą, a koszt dopisuje PO niej, więc burst w wielu
      // rozmowach naraz potrafił wydać wielokrotność sufitu, zanim
      // którykolwiek koszt trafił do licznika. Lease per rozmowa tego nie
      // łapie — każda rozmowa jest „wolna".
      process.env.AI_STUB_DELAY_MS = '1500';
      process.env.AI_MAX_CONCURRENT_TURNS_PER_HOUSEHOLD = '2';
      try {
        const conversations = await Promise.all(
          Array.from({ length: 6 }, () =>
            createConversation(session.accessToken, householdId),
          ),
        );
        const before = await readQuota(householdId);

        const results = await Promise.all(
          conversations.map((conversation) =>
            postMessage(session.accessToken, conversation.id, {
              clientMessageId: randomUUID(),
              text: 'Burst',
            }),
          ),
        );

        const accepted = results.filter((res) => res.status === 202);
        const rejected = results.filter((res) => res.status === 409);
        expect(accepted.length).toBeGreaterThanOrEqual(1);
        expect(accepted.length).toBeLessThanOrEqual(2);
        expect(accepted.length + rejected.length).toBe(6);
        for (const res of rejected) {
          expect(res.body).toMatchObject({ code: 'AI_TURN_IN_PROGRESS' });
        }

        // Kwota schodzi dokładnie tyle razy, ile tur naprawdę ruszyło —
        // odmowa nie ma prawa spalić nikomu wiadomości z puli.
        expect(await readQuota(householdId)).toBe(before + accepted.length);
        const running = await prisma.agentTurn.count({
          where: {
            conversation: { householdId },
            status: 'RUNNING',
          },
        });
        expect(running).toBeLessThanOrEqual(2);

        await Promise.all(
          accepted.map((res) =>
            pollTurn(session.accessToken, (res.body as AcceptedTurn).turnId),
          ),
        );
      } finally {
        process.env.AI_STUB_DELAY_MS = '0';
        delete process.env.AI_MAX_CONCURRENT_TURNS_PER_HOUSEHOLD;
      }
    });

    it('„Stop" przerywa turę: AI_CANCELLED, kwota wraca, podpowiedzi, activeTurnId znika', async () => {
      process.env.AI_STUB_DELAY_MS = '1500';
      try {
        const conversation = await createConversation(
          session.accessToken,
          householdId,
        );
        const before = await readQuota(householdId);
        const accepted = await postMessage(
          session.accessToken,
          conversation.id,
          {
            clientMessageId: randomUUID(),
            text: 'Długa tura do przerwania',
          },
        ).expect(202);
        const turnId = (accepted.body as AcceptedTurn).turnId;

        // Powrót do rozmowy w trakcie: jedna rozmowa niesie biegnącą turę.
        const during = await request(app.getHttpServer())
          .get(`/agent/conversations/${conversation.id}`)
          .set(auth(session.accessToken))
          .expect(200);
        expect(during.body).toMatchObject({
          id: conversation.id,
          activeTurnId: turnId,
        });

        const cancelled = await request(app.getHttpServer())
          .post(`/agent/turns/${turnId}/cancel`)
          .set(auth(session.accessToken))
          .expect(200);
        expect(cancelled.body).toMatchObject({
          status: 'FAILED',
          errorCode: 'AI_CANCELLED',
          suggestions: ['Zaplanuj tylko obiady', 'Zaplanuj 3 dni'],
        });
        expect(await readQuota(householdId)).toBe(before);

        // Drugie kliknięcie nie jest błędem i niczego nie zmienia.
        await request(app.getHttpServer())
          .post(`/agent/turns/${turnId}/cancel`)
          .set(auth(session.accessToken))
          .expect(200);
        expect(await readQuota(householdId)).toBe(before);

        const after = await request(app.getHttpServer())
          .get(`/agent/conversations/${conversation.id}`)
          .set(auth(session.accessToken))
          .expect(200);
        expect(after.body).toMatchObject({ activeTurnId: null });
      } finally {
        process.env.AI_STUB_DELAY_MS = '0';
      }
    });

    it('cudza rozmowa po id: 404, nie 403', async () => {
      const conversation = await createConversation(
        session.accessToken,
        householdId,
      );
      const outsider = await devLogin('Obcy2');
      await request(app.getHttpServer())
        .get(`/agent/conversations/${conversation.id}`)
        .set(auth(outsider.accessToken))
        .expect(404);
    });

    it('tura-zombie po padzie procesu NIE blokuje rozmowy na zawsze', async () => {
      const conversation = await createConversation(
        session.accessToken,
        householdId,
      );
      const message = await prisma.agentMessage.create({
        data: {
          conversationId: conversation.id,
          role: 'USER',
          kind: 'TEXT',
          text: 'Wiadomość sprzed padu',
        },
        select: { id: true },
      });
      // Tura, której nikt nie domknie: proces padł w jej trakcie (deploy, OOM).
      // Bez okna czasu w lease ta rozmowa oddawałaby 409 do końca świata,
      // a jedynym ratunkiem byłby odczyt tury po id, którego klient nie ma.
      await prisma.agentTurn.create({
        data: {
          conversationId: conversation.id,
          userId: session.user.id,
          userMessageId: message.id,
          requestId: 'zombie',
          status: 'RUNNING',
          startedAt: new Date(Date.now() - 10 * 60 * 1000),
        },
      });

      await postMessage(session.accessToken, conversation.id, {
        clientMessageId: randomUUID(),
        text: 'Nowa wiadomość mimo zombie',
      }).expect(202);
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

  describe('lista rozmów', () => {
    it('lista rozmów niesie podgląd ostatniej wiadomości', async () => {
      const conversation = await createConversation(
        session.accessToken,
        householdId,
      );
      const accepted = await postMessage(session.accessToken, conversation.id, {
        clientMessageId: randomUUID(),
        text: 'Co na kolację?',
      }).expect(202);
      await pollTurn(
        session.accessToken,
        (accepted.body as AcceptedTurn).turnId,
      );

      const list = await request(app.getHttpServer())
        .get('/agent/conversations')
        .set(auth(session.accessToken))
        .expect(200);
      const listed = (
        list.body as { id: string; preview: string | null }[]
      ).find((item) => item.id === conversation.id);

      // Bez podglądu lista rozmów jest listą dat — nie da się rozpoznać,
      // do której wracasz.
      expect(listed?.preview).toBe('[stub] Co na kolację?');
    });

    it('kasowanie JEDNEJ rozmowy zostawia pozostałe', async () => {
      const keep = await createConversation(session.accessToken, householdId);
      const remove = await createConversation(session.accessToken, householdId);
      // Pusta rozmowa nie trafia na listę (#152), więc `keep` musi coś mieć —
      // inaczej jej brak na liście nie mówiłby nic o kasowaniu.
      const accepted = await postMessage(session.accessToken, keep.id, {
        clientMessageId: randomUUID(),
        text: 'Zostaję',
      }).expect(202);
      await pollTurn(
        session.accessToken,
        (accepted.body as AcceptedTurn).turnId,
      );

      await request(app.getHttpServer())
        .delete(`/agent/conversations/${remove.id}`)
        .set(auth(session.accessToken))
        .expect(200);

      const list = await request(app.getHttpServer())
        .get('/agent/conversations')
        .set(auth(session.accessToken))
        .expect(200);
      const ids = (list.body as { id: string }[]).map((item) => item.id);
      expect(ids).toContain(keep.id);
      expect(ids).not.toContain(remove.id);
    });

    it('cudza rozmowa: 404, nie 403 — inaczej da się zgadywać identyfikatory', async () => {
      const stranger = await devLogin('Nieproszony');
      const mine = await createConversation(session.accessToken, householdId);

      const res = await request(app.getHttpServer())
        .delete(`/agent/conversations/${mine.id}`)
        .set(auth(stranger.accessToken))
        .expect(404);
      expect(res.body).toMatchObject({ code: 'AI_CONVERSATION_NOT_FOUND' });
    });
  });

  describe('pamięć asystenta', () => {
    it('lista i kasowanie notatki — użytkownik widzi, co asystent o nim wie', async () => {
      const note = await prisma.agentMemory.create({
        data: {
          householdId,
          text: 'W piątki zamawiają pizzę',
          textNormalized: 'w piątki zamawiają pizzę',
          createdByUserId: session.user.id,
        },
        select: { id: true },
      });

      const listed = await request(app.getHttpServer())
        .get('/agent/memory')
        .query({ householdId })
        .set(auth(session.accessToken))
        .expect(200);
      expect(
        (listed.body as { id: string; text: string }[]).map((n) => n.text),
      ).toContain('W piątki zamawiają pizzę');

      await request(app.getHttpServer())
        .delete(`/agent/memory/${note.id}`)
        .set(auth(session.accessToken))
        .expect(200);

      const after = await prisma.agentMemory.findUnique({
        where: { id: note.id },
        select: { id: true },
      });
      expect(after).toBeNull();
    });

    it('„Usuń wszystkie notatki" kasuje notatki domu; rodzaj notatki wraca w liście', async () => {
      await prisma.agentMemory.createMany({
        data: [
          {
            householdId,
            text: 'Franek nie je ostrego',
            textNormalized: 'franek nie je ostrego',
            kind: 'CONSTRAINT',
          },
          {
            householdId,
            text: 'Niedzielny obiad gotuje Ania',
            textNormalized: 'niedzielny obiad gotuje ania',
            kind: 'HABIT',
          },
        ],
      });
      const listed = await request(app.getHttpServer())
        .get('/agent/memory')
        .query({ householdId })
        .set(auth(session.accessToken))
        .expect(200);
      const kinds = new Map(
        (listed.body as { text: string; kind: string }[]).map((n) => [
          n.text,
          n.kind,
        ]),
      );
      expect(kinds.get('Franek nie je ostrego')).toBe('CONSTRAINT');
      expect(kinds.get('Niedzielny obiad gotuje Ania')).toBe('HABIT');

      const wiped = await request(app.getHttpServer())
        .delete('/agent/memory')
        .query({ householdId })
        .set(auth(session.accessToken))
        .expect(200);
      expect(
        (wiped.body as { deleted: number }).deleted,
      ).toBeGreaterThanOrEqual(2);
      expect(await prisma.agentMemory.count({ where: { householdId } })).toBe(
        0,
      );

      const stranger = await devLogin('Cudzy');
      await request(app.getHttpServer())
        .delete('/agent/memory')
        .query({ householdId })
        .set(auth(stranger.accessToken))
        .expect(403);
    });

    // USUNIĘTY TEST: `GET /agent/context`.
    //
    // Trasa powstała w b5c9536 i została zdjęta w 78a7b7d („zakres pytania
    // znika z serwera”), a test o niej został i od tamtej pory pada na 404.
    // Nikt tego nie zauważył, bo CI stoi na rozliczeniach GitHuba od 11.09.
    // Chipy kontekstu przychodzą do klienta razem z turą (`usedContext`),
    // więc nie ma czego przywracać — jest co skasować (audyt 12.09.2026).
    it('cudza notatka: 404, nie 403 — inaczej da się zgadywać identyfikatory', async () => {
      const note = await prisma.agentMemory.create({
        data: {
          householdId,
          text: 'Notatka do podejrzenia',
          textNormalized: 'notatka do podejrzenia',
        },
        select: { id: true },
      });
      const stranger = await devLogin('Wscibski');

      const res = await request(app.getHttpServer())
        .delete(`/agent/memory/${note.id}`)
        .set(auth(stranger.accessToken))
        .expect(404);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('cudze gospodarstwo: 403 NOT_HOUSEHOLD_MEMBER', async () => {
      const stranger = await devLogin('Ciekawski');
      const res = await request(app.getHttpServer())
        .get('/agent/memory')
        .query({ householdId })
        .set(auth(stranger.accessToken))
        .expect(403);
      expect(res.body).toMatchObject({ code: 'NOT_HOUSEHOLD_MEMBER' });
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
        // 429 mówi, KIEDY limit wraca — telefon może pokazać datę zamiast
        // gołego „wyczerpany".
        expect(blocked.body.details).toEqual([
          'kind:messages',
          'limit:2',
          'remaining:0',
          'tier:PRO',
          expect.stringMatching(/^resetsAt:\d{4}-\d{2}-01T00:00:00\.000Z$/),
        ]);

        // Te same liczby z GET /agent/usage — bez turnięcia zużycia.
        const usage = await request(app.getHttpServer())
          .get('/agent/usage')
          .query({ householdId: quotaHousehold })
          .set(auth(quotaUser.accessToken))
          .expect(200);
        expect(usage.body).toMatchObject({
          householdId: quotaHousehold,
          tier: 'PRO',
          messages: { used: 2, limit: 2, remaining: 0 },
          plans: { used: 0, remaining: expect.any(Number) },
        });
        expect(usage.body.resetsAt).toMatch(/-01T00:00:00\.000Z$/);

        // Cudze gospodarstwo: członkostwo PRZED liczbami.
        await request(app.getHttpServer())
          .get('/agent/usage')
          .query({ householdId: quotaHousehold })
          .set(auth(session.accessToken))
          .expect(403);
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

  // Cały tor propozycji przez PRAWDZIWY serwer: tura kończy się kartą,
  // plan zostaje nietknięty, a zmienia go dopiero kliknięcie użytkownika.
  describe('propozycje i karty', () => {
    let recipeId: string;

    type CardMessage = {
      role: string;
      kind?: string;
      card?: {
        kind: string;
        proposalId: string;
        actions: { type: string; proposalId: string | null }[];
        state: { status: string; canApply: boolean; canUndo: boolean };
      };
      usedContext?: string[];
    };

    const weekItems = () =>
      prisma.planItem.count({
        where: {
          weeklyPlan: {
            householdId,
            weekStart: new Date(`${WEEK_START}T00:00:00.000Z`),
          },
        },
      });

    const history = async (conversationId: string): Promise<CardMessage[]> => {
      const res = await request(app.getHttpServer())
        .get(`/agent/conversations/${conversationId}/messages`)
        .set(auth(session.accessToken))
        .expect(200);
      return (res.body as { messages: CardMessage[] }).messages;
    };

    beforeAll(async () => {
      process.env.AI_CARDS_MODE = 'soft';
      const dinner = await prisma.recipe.findFirst({
        where: { isCatalog: true, suitableMealTypes: { has: 'DINNER' } },
        select: { id: true },
      });
      if (!dinner) throw new Error('katalog nie ma kolacji');
      recipeId = dinner.id;
    });

    afterAll(() => {
      process.env.AI_CARDS_MODE = original.AI_CARDS_MODE;
    });

    it('tura kończy się kartą, a plan zostaje nietknięty', async () => {
      const conversation = await createConversation(
        session.accessToken,
        householdId,
      );
      const accepted = await postMessage(session.accessToken, conversation.id, {
        clientMessageId: randomUUID(),
        text: `Ułóż tydzień [[propose:${recipeId}:${WEEK_START}]]`,
        clientCapabilities: [CARDS_CAPABILITY_V1],
      }).expect(202);

      const done = await pollTurn(
        session.accessToken,
        (accepted.body as AcceptedTurn).turnId,
      );
      expect(done.status).toBe('DONE');
      // Plan się NIE zmienił — na tym polega cała obietnica.
      expect(await weekItems()).toBe(0);

      const messages = await history(conversation.id);
      const assistant = messages[messages.length - 1];
      expect(assistant.kind).toBe('PLAN_WEEK');
      expect(assistant.card).toMatchObject({
        kind: 'PLAN_WEEK',
        state: { status: 'PENDING', canApply: true, canUndo: false },
      });
      // „Uwzględniłem: …" — z czym serwer policzył tę odpowiedź.
      expect(assistant.usedContext).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^Tydzień /),
          'Cały dom · 1',
        ]),
      );
      const apply = assistant.card?.actions.find((a) => a.type === 'APPLY');
      expect(apply?.proposalId).toBe(assistant.card?.proposalId);

      // Zatwierdzenie: bez modelu, więc bez kosztu — i dopiero teraz plan.
      const proposalId = assistant.card!.proposalId;
      await request(app.getHttpServer())
        .post(`/agent/proposals/${proposalId}/apply`)
        .set(auth(session.accessToken))
        .expect(200);
      expect(await weekItems()).toBe(1);

      const afterApply = await history(conversation.id);
      const applied = afterApply[afterApply.length - 1];
      expect(applied.kind).toBe('APPLIED');
      expect(applied.card?.actions.map((a) => a.type)).toContain('UNDO');
      // Karta propozycji w HISTORII sama przestaje zapraszać do kliknięcia.
      const stale = afterApply.find((m) => m.card?.kind === 'PLAN_WEEK');
      expect(stale?.card?.state).toMatchObject({
        status: 'APPLIED',
        canApply: false,
      });

      await request(app.getHttpServer())
        .post(`/agent/proposals/${proposalId}/undo`)
        .set(auth(session.accessToken))
        .expect(200);
      expect(await weekItems()).toBe(0);
    });

    it('karta jest sterownikiem: ponowny zapis po cofnięciu, „Zapisz mimo to" po zmianie planu', async () => {
      const conversation = await createConversation(
        session.accessToken,
        householdId,
      );
      const accepted = await postMessage(session.accessToken, conversation.id, {
        clientMessageId: randomUUID(),
        text: `Ułóż tydzień [[propose:${recipeId}:${WEEK_START}]]`,
        clientCapabilities: [CARDS_CAPABILITY_V1],
      }).expect(202);
      await pollTurn(
        session.accessToken,
        (accepted.body as AcceptedTurn).turnId,
      );
      const messages = await history(conversation.id);
      const proposalId = messages[messages.length - 1].card!.proposalId;
      const apply = (body: Record<string, unknown> = {}) =>
        request(app.getHttpServer())
          .post(`/agent/proposals/${proposalId}/apply`)
          .set(auth(session.accessToken))
          .send(body);
      const undo = () =>
        request(app.getHttpServer())
          .post(`/agent/proposals/${proposalId}/undo`)
          .set(auth(session.accessToken));

      // UNDONE → „Zastosuj ponownie" zwykłym kliknięciem.
      await apply().expect(200);
      await undo().expect(200);
      expect(await weekItems()).toBe(0);
      const undone = (await history(conversation.id)).find(
        (m) => m.card?.kind === 'PLAN_WEEK',
      );
      expect(undone?.card?.state).toMatchObject({
        status: 'UNDONE',
        canApply: true,
      });
      await apply().expect(200);
      expect(await weekItems()).toBe(1);
      await undo().expect(200);

      // Ręczna zmiana planu spod ręki → STALE; bez `force` odmowa, z `force` zapis.
      // Po cofnięciu wiersz tygodnia zostaje (pusty) — stąd upsert.
      await prisma.weeklyPlan.upsert({
        where: {
          householdId_weekStart: {
            householdId,
            weekStart: new Date(`${WEEK_START}T00:00:00.000Z`),
          },
        },
        create: {
          householdId,
          weekStart: new Date(`${WEEK_START}T00:00:00.000Z`),
          items: {
            create: [{ dayOfWeek: 'TUE', mealType: 'DINNER', recipeId }],
          },
        },
        update: {
          items: {
            create: [{ dayOfWeek: 'TUE', mealType: 'DINNER', recipeId }],
          },
        },
      });
      const refused = await apply().expect(409);
      expect(refused.body).toMatchObject({ code: 'AI_PROPOSAL_STALE' });
      const stale = (await history(conversation.id)).find(
        (m) => m.card?.kind === 'PLAN_WEEK',
      );
      expect(stale?.card?.state).toMatchObject({
        status: 'STALE',
        canApply: true,
      });
      await apply({ force: true }).expect(200);
      // Stan docelowy propozycji: poniedziałek; ręczny wtorek znika.
      expect(await weekItems()).toBe(1);
      await undo().expect(200);
      await prisma.weeklyPlan.deleteMany({
        where: {
          householdId,
          weekStart: new Date(`${WEEK_START}T00:00:00.000Z`),
        },
      });
    });

    it('„Cofnij", którego domena odmawia (alergen dodany po zapisie), NIE udaje sukcesu; po zdjęciu alergenu cofa dokładnie raz', async () => {
      const weekStartDate = new Date(`${WEEK_START}T00:00:00.000Z`);
      // R — danie z alergenem, stoi w planie PRZED propozycją; N — bez żadnego.
      const withAllergen = await prisma.recipe.findFirst({
        where: {
          isCatalog: true,
          suitableMealTypes: { has: 'DINNER' },
          NOT: { allergens: { isEmpty: true } },
        },
        select: { id: true, allergens: true },
      });
      const clean = await prisma.recipe.findFirst({
        where: {
          isCatalog: true,
          suitableMealTypes: { has: 'DINNER' },
          allergens: { isEmpty: true },
        },
        select: { id: true },
      });
      if (!withAllergen || !clean) {
        throw new Error('katalog nie ma pary kolacji z alergenem i bez');
      }
      const allergen = withAllergen.allergens[0];

      const planRecipes = async () =>
        (
          await prisma.planItem.findMany({
            where: { weeklyPlan: { householdId, weekStart: weekStartDate } },
            select: { dayOfWeek: true, mealType: true, recipeId: true },
          })
        ).map((item) => `${item.dayOfWeek}:${item.mealType}:${item.recipeId}`);
      const setAllergens = (allergens: string[]) =>
        prisma.userPreference.upsert({
          where: { userId: session.user.id },
          create: { userId: session.user.id, allergens },
          update: { allergens },
        });

      await prisma.weeklyPlan.deleteMany({
        where: { householdId, weekStart: weekStartDate },
      });
      await prisma.weeklyPlan.create({
        data: {
          householdId,
          weekStart: weekStartDate,
          items: {
            create: [
              {
                dayOfWeek: 'MON',
                mealType: 'DINNER',
                recipeId: withAllergen.id,
              },
            ],
          },
        },
      });

      try {
        const conversation = await createConversation(
          session.accessToken,
          householdId,
        );
        const accepted = await postMessage(
          session.accessToken,
          conversation.id,
          {
            clientMessageId: randomUUID(),
            text: `Podmień kolację [[propose:${clean.id}:${WEEK_START}]]`,
            clientCapabilities: [CARDS_CAPABILITY_V1],
          },
        ).expect(202);
        await pollTurn(
          session.accessToken,
          (accepted.body as AcceptedTurn).turnId,
        );
        const messages = await history(conversation.id);
        const proposalId = messages[messages.length - 1].card!.proposalId;
        const undo = () =>
          request(app.getHttpServer())
            .post(`/agent/proposals/${proposalId}/undo`)
            .set(auth(session.accessToken));

        await request(app.getHttpServer())
          .post(`/agent/proposals/${proposalId}/apply`)
          .set(auth(session.accessToken))
          .expect(200);
        expect(await planRecipes()).toEqual([`MON:DINNER:${clean.id}`]);

        const appliedRow = await prisma.agentProposal.findUniqueOrThrow({
          where: { id: proposalId },
        });
        expect(appliedRow.quotaPeriodKey).not.toBeNull();
        const scopeId = appliedRow.quotaScopeId ?? householdId;
        const periodKey = appliedRow.quotaPeriodKey!;
        const plansUsed = async () =>
          (
            await prisma.aiUsageCounter.findUnique({
              where: {
                scopeId_periodKey_kind: { scopeId, periodKey, kind: 'plans' },
              },
            })
          )?.value ?? 0;
        const messageTexts = async () =>
          (
            await prisma.agentMessage.findMany({
              where: { conversationId: conversation.id },
              select: { text: true },
            })
          ).map((message) => message.text);
        const usedAfterApply = await plansUsed();
        const messagesAfterApply = (await messageTexts()).length;
        expect(usedAfterApply).toBeGreaterThan(0);

        // Domownik dodaje alergen: R nie wolno już wstawić, a bieżący plan
        // (N) nadal zgadza się z `appliedHash`.
        await setAllergens([allergen]);

        // Dwa razy — ponowienie odmowy ma dać to samo i niczego nie ruszyć.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const refused = await undo().expect(409);
          expect(refused.body).toMatchObject({ code: 'AI_PROPOSAL_STALE' });
          expect((refused.body as { details: string[] }).details).toEqual(
            expect.arrayContaining([
              'reason:VIOLATIONS',
              'RECIPE_ALLERGEN_CONFLICT',
            ]),
          );

          expect(await planRecipes()).toEqual([`MON:DINNER:${clean.id}`]);
          const row = await prisma.agentProposal.findUniqueOrThrow({
            where: { id: proposalId },
          });
          expect(row).toMatchObject({
            status: 'APPLIED',
            undoneAt: null,
            quotaPeriodKey: periodKey,
            appliedHash: appliedRow.appliedHash,
          });
          expect(await plansUsed()).toBe(usedAfterApply);
          const texts = await messageTexts();
          expect(texts).toHaveLength(messagesAfterApply);
          expect(texts.some((text) => text.startsWith('Cofnąłem'))).toBe(false);
        }

        // Alergen zdjęty → cofnięcie przechodzi. Dwa żądania NARAZ: oba 200,
        // ale kwota wraca raz i wiadomość jest jedna.
        await setAllergens([]);
        const [first, second] = await Promise.all([undo(), undo()]);
        expect([first.status, second.status]).toEqual([200, 200]);
        expect(await planRecipes()).toEqual([`MON:DINNER:${withAllergen.id}`]);
        const undoneRow = await prisma.agentProposal.findUniqueOrThrow({
          where: { id: proposalId },
        });
        expect(undoneRow).toMatchObject({
          status: 'UNDONE',
          quotaPeriodKey: null,
          quotaScopeId: null,
        });
        expect(undoneRow.undoneAt).not.toBeNull();
        expect(await plansUsed()).toBe(usedAfterApply - 1);

        // Trzecie kliknięcie: ten sam wynik, bez drugiego zwrotu.
        await undo().expect(200);
        expect(await plansUsed()).toBe(usedAfterApply - 1);
        expect(
          (await messageTexts()).filter((text) => text.startsWith('Cofnąłem')),
        ).toHaveLength(1);
      } finally {
        await setAllergens([]);
        await prisma.weeklyPlan.deleteMany({
          where: { householdId, weekStart: weekStartDate },
        });
      }
    });

    /**
     * Przeploty cofnięcia na ŻYWEJ bazie, z wymuszoną kolejnością.
     *
     * Bariera stoi na wejściu do `applyWeekPlan`: żądanie zatrzymane w tym
     * miejscu ma już za sobą odczyt propozycji i wszystkie kontrole wstępne,
     * a nie dotknęło jeszcze planu — dokładnie ten moment, w którym spóźnione
     * cofnięcie jest groźne. Żadnych `setTimeout`: test sam zwalnia barierę.
     */
    describe('cofnięcie pod współbieżnością', () => {
      const weekStartDate = new Date(`${WEEK_START}T00:00:00.000Z`);
      let weeklyPlans: WeeklyPlansService;
      let counters: AiUsageCountersService;
      let before: string; // R — stoi w planie przed propozycją
      let manual: string; // X — ręczna edycja domownika

      type Deferred = { promise: Promise<void>; resolve: () => void };
      const deferred = (): Deferred => {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => (resolve = done));
        return { promise, resolve };
      };

      /** Zatrzymuje pierwsze `count` wejść do `applyWeekPlan` do `release()`. */
      const holdApplyWeekPlan = (count: number) => {
        const arrived = Array.from({ length: count }, deferred);
        const gate = deferred();
        const original = weeklyPlans.applyWeekPlan.bind(weeklyPlans);
        let seen = 0;
        jest
          .spyOn(weeklyPlans, 'applyWeekPlan')
          .mockImplementation(async (...args) => {
            const mine = seen;
            seen += 1;
            if (mine < count) {
              arrived[mine].resolve();
              await gate.promise;
            }
            return original(...args);
          });
        return {
          allArrived: () => Promise.all(arrived.map((entry) => entry.promise)),
          release: () => gate.resolve(),
        };
      };

      const planRecipes = async () =>
        (
          await prisma.planItem.findMany({
            where: { weeklyPlan: { householdId, weekStart: weekStartDate } },
            select: { dayOfWeek: true, mealType: true, recipeId: true },
          })
        )
          .map((item) => `${item.dayOfWeek}:${item.mealType}:${item.recipeId}`)
          .sort();

      /** Plan z R, propozycja podmienia na N (`recipeId`) i jest ZAPISANA. */
      const prepareApplied = async () => {
        await prisma.weeklyPlan.deleteMany({
          where: { householdId, weekStart: weekStartDate },
        });
        await prisma.weeklyPlan.create({
          data: {
            householdId,
            weekStart: weekStartDate,
            items: {
              create: [
                { dayOfWeek: 'MON', mealType: 'DINNER', recipeId: before },
              ],
            },
          },
        });
        const conversation = await createConversation(
          session.accessToken,
          householdId,
        );
        const accepted = await postMessage(
          session.accessToken,
          conversation.id,
          {
            clientMessageId: randomUUID(),
            text: `Podmień kolację [[propose:${recipeId}:${WEEK_START}]]`,
            clientCapabilities: [CARDS_CAPABILITY_V1],
          },
        ).expect(202);
        await pollTurn(
          session.accessToken,
          (accepted.body as AcceptedTurn).turnId,
        );
        const messages = await history(conversation.id);
        const proposalId = messages[messages.length - 1].card!.proposalId;
        const apply = () =>
          request(app.getHttpServer())
            .post(`/agent/proposals/${proposalId}/apply`)
            .set(auth(session.accessToken));
        const undo = () =>
          request(app.getHttpServer())
            .post(`/agent/proposals/${proposalId}/undo`)
            .set(auth(session.accessToken));
        await apply().expect(200);
        const row = await prisma.agentProposal.findUniqueOrThrow({
          where: { id: proposalId },
        });
        const scopeId = row.quotaScopeId ?? householdId;
        const periodKey = row.quotaPeriodKey!;
        const plansUsed = async () =>
          (
            await prisma.aiUsageCounter.findUnique({
              where: {
                scopeId_periodKey_kind: { scopeId, periodKey, kind: 'plans' },
              },
            })
          )?.value ?? 0;
        const confirmations = async () =>
          (
            await prisma.agentMessage.findMany({
              where: { conversationId: conversation.id },
              select: { text: true },
            })
          ).filter((message) => message.text.startsWith('Cofnąłem')).length;
        const proposal = () =>
          prisma.agentProposal.findUniqueOrThrow({ where: { id: proposalId } });
        return {
          apply,
          undo,
          proposal,
          plansUsed,
          confirmations,
          appliedRow: row,
          usedAfterApply: await plansUsed(),
        };
      };

      beforeAll(async () => {
        weeklyPlans = app.get(WeeklyPlansService);
        counters = app.get(AiUsageCountersService);
        const others = await prisma.recipe.findMany({
          where: {
            isCatalog: true,
            suitableMealTypes: { has: 'DINNER' },
            allergens: { isEmpty: true },
            id: { not: recipeId },
          },
          select: { id: true },
          take: 2,
        });
        if (others.length < 2) throw new Error('katalog ma za mało kolacji');
        [before, manual] = others.map((recipe) => recipe.id);
      });

      afterEach(async () => {
        jest.restoreAllMocks();
        await prisma.weeklyPlan.deleteMany({
          where: { householdId, weekStart: weekStartDate },
        });
      });

      it('A: spóźnione drugie cofnięcie nie kasuje ręcznej edycji domownika', async () => {
        const ctx = await prepareApplied();
        const hold = holdApplyWeekPlan(1);

        // B przechodzi kontrole i staje tuż przed zapisem planu.
        const late = ctx.undo().then((res) => res);
        await hold.allArrived();

        // A cofa do końca, potem domownik dokłada wtorek.
        await ctx.undo().expect(200);
        await weeklyPlans.upsertWeekSlot(
          session.user.id,
          householdId,
          WEEK_START,
          { dayOfWeek: 'TUE', mealType: 'DINNER', recipeId: manual },
        );
        const expected = [
          `MON:DINNER:${before}`,
          `TUE:DINNER:${manual}`,
        ].sort();
        expect(await planRecipes()).toEqual(expected);

        hold.release();
        const lateRes = await late;

        // Wtorek domownika MUSI przeżyć — niezależnie od kodu odpowiedzi.
        expect(await planRecipes()).toEqual(expected);
        expect(lateRes.status).toBe(200);
        expect((lateRes.body as { status: string }).status).toBe('UNDONE');
        expect(await ctx.proposal()).toMatchObject({
          status: 'UNDONE',
          quotaPeriodKey: null,
        });
        expect(await ctx.plansUsed()).toBe(ctx.usedAfterApply - 1);
        expect(await ctx.confirmations()).toBe(1);
      });

      it('B: cofnięcie spóźnione o cykl „cofnij → zastosuj ponownie" nie rusza nowego zapisu', async () => {
        const ctx = await prepareApplied();
        const hold = holdApplyWeekPlan(1);

        const late = ctx.undo().then((res) => res);
        await hold.allArrived();

        await ctx.undo().expect(200);
        await ctx.apply().expect(200);
        const reapplied = await ctx.proposal();
        expect(reapplied.status).toBe('APPLIED');
        expect(reapplied.appliedAt).not.toEqual(ctx.appliedRow.appliedAt);
        expect(await planRecipes()).toEqual([`MON:DINNER:${recipeId}`]);

        hold.release();
        const lateRes = await late;

        expect(await planRecipes()).toEqual([`MON:DINNER:${recipeId}`]);
        expect(lateRes.status).toBe(409);
        expect(lateRes.body).toMatchObject({ code: 'AI_PROPOSAL_STALE' });
        const after = await ctx.proposal();
        expect(after).toMatchObject({
          status: 'APPLIED',
          appliedHash: reapplied.appliedHash,
          quotaPeriodKey: reapplied.quotaPeriodKey,
          quotaScopeId: reapplied.quotaScopeId,
        });
        expect(after.appliedAt).toEqual(reapplied.appliedAt);
        // Zapis → zwrot → ponowny zapis: kwota nowego zapisu zostaje zjedzona.
        expect(await ctx.plansUsed()).toBe(ctx.usedAfterApply);
        expect(await ctx.confirmations()).toBe(1);
      });

      it('C: awaria zwrotu kwoty nie gubi go — nic się nie zatwierdza, a ponowienie rozlicza dokładnie raz', async () => {
        const ctx = await prepareApplied();
        const originalAdd = counters.add.bind(counters);
        let failed = false;
        jest.spyOn(counters, 'add').mockImplementation((...args) => {
          if (!failed && args[3] === 'plans' && args[4] < 0) {
            failed = true;
            return Promise.reject(new Error('licznik padł'));
          }
          return originalAdd(...args);
        });

        await ctx.undo().expect(500);
        expect(failed).toBe(true);
        // Należny zwrot nie mógł zniknąć: albo jest wykonany, albo propozycja
        // nadal go niesie. Tutaj — wszystko wycofane razem z planem.
        expect(await planRecipes()).toEqual([`MON:DINNER:${recipeId}`]);
        expect(await ctx.proposal()).toMatchObject({
          status: 'APPLIED',
          undoneAt: null,
          quotaPeriodKey: ctx.appliedRow.quotaPeriodKey,
          quotaScopeId: ctx.appliedRow.quotaScopeId,
        });
        expect(await ctx.plansUsed()).toBe(ctx.usedAfterApply);
        expect(await ctx.confirmations()).toBe(0);

        await ctx.undo().expect(200);
        expect(await planRecipes()).toEqual([`MON:DINNER:${before}`]);
        expect(await ctx.proposal()).toMatchObject({
          status: 'UNDONE',
          quotaPeriodKey: null,
        });
        expect(await ctx.plansUsed()).toBe(ctx.usedAfterApply - 1);
        expect(await ctx.confirmations()).toBe(1);

        await ctx.undo().expect(200);
        expect(await ctx.plansUsed()).toBe(ctx.usedAfterApply - 1);
        expect(await ctx.confirmations()).toBe(1);
      });

      it('E: cofnięcie, które trafia na edycję domownika W TOKU, czeka na nią i odmawia — bez zwrotu i bez wiadomości', async () => {
        const ctx = await prepareApplied();
        const week = await prisma.weeklyPlan.findUniqueOrThrow({
          where: {
            householdId_weekStart: { householdId, weekStart: weekStartDate },
          },
        });
        const locked = deferred();
        const mayFinish = deferred();
        // Edycja ma zamek tygodnia, ale jeszcze nie zatwierdziła: cofnięcie
        // czyta więc plan zgodny z `appliedHash` i przechodzi kontrole wstępne.
        const manualEdit = prisma.$transaction(
          async (tx) => {
            await lockWeekForWrite(tx, week.id);
            locked.resolve();
            await mayFinish.promise;
            await tx.planItem.create({
              data: {
                weeklyPlanId: week.id,
                dayOfWeek: 'TUE',
                mealType: 'DINNER',
                recipeId: manual,
              },
            });
          },
          { timeout: 15_000 },
        );
        await locked.promise;

        const late = ctx.undo().then((res) => res);
        const deadline = Date.now() + 10_000;
        for (;;) {
          if (Date.now() > deadline) {
            mayFinish.resolve();
            throw new Error('cofnięcie nie stanęło na zamku tygodnia');
          }
          const [{ waiting }] = await prisma.$queryRaw<{ waiting: bigint }[]>`
            SELECT count(*) AS waiting FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`;
          if (waiting > 0n) break;
          await new Promise((resolve) => setImmediate(resolve));
        }
        mayFinish.resolve();
        await manualEdit;
        const lateRes = await late;

        expect(lateRes.status).toBe(409);
        expect(lateRes.body).toMatchObject({
          code: 'AI_PROPOSAL_STALE',
          details: ['reason:CHANGED_AFTER_APPLY'],
        });
        expect(await planRecipes()).toEqual(
          [`MON:DINNER:${recipeId}`, `TUE:DINNER:${manual}`].sort(),
        );
        expect(await ctx.proposal()).toMatchObject({
          status: 'APPLIED',
          undoneAt: null,
          quotaPeriodKey: ctx.appliedRow.quotaPeriodKey,
        });
        expect(await ctx.plansUsed()).toBe(ctx.usedAfterApply);
        expect(await ctx.confirmations()).toBe(0);
      });

      it('D: dwa cofnięcia zwolnione z bariery naraz — jeden zwrot, jedno potwierdzenie', async () => {
        const ctx = await prepareApplied();
        const hold = holdApplyWeekPlan(2);

        const first = ctx.undo().then((res) => res);
        const second = ctx.undo().then((res) => res);
        // Oba przeczytały TĘ SAMĄ zapisaną propozycję i oba stoją przed zapisem.
        await hold.allArrived();
        hold.release();
        const results = await Promise.all([first, second]);

        expect(results.map((res) => res.status)).toEqual([200, 200]);
        const texts = results.map(
          (res) => (res.body as { message: { text: string } }).message.text,
        );
        expect(
          texts.filter((text) => text.startsWith('Cofnąłem')),
        ).toHaveLength(1);
        expect(await planRecipes()).toEqual([`MON:DINNER:${before}`]);
        expect(await ctx.proposal()).toMatchObject({
          status: 'UNDONE',
          quotaPeriodKey: null,
          quotaScopeId: null,
        });
        expect(await ctx.plansUsed()).toBe(ctx.usedAfterApply - 1);
        expect(await ctx.confirmations()).toBe(1);
      });

      // Zapis propozycji (`apply`) — ta sama transakcja zapisu planu, co
      // cofnięcie: przejęcie, odcisk, plan, kwota, wiadomość i odcisk „po"
      // zatwierdzają się razem albo wcale.
      describe('zapis pod współbieżnością i awariami', () => {
        // Każdy przypadek to osobna tura w TYM SAMYM domu, a pula wiadomości
        // najmniejszego planu (30) skończyłaby się w połowie suity. Ta sekcja
        // testuje zapis planu, nie kwotę wiadomości: na czas jej trwania sufit
        // (env czytany per żądanie), a po niej licznik wiadomości wraca do
        // stanu sprzed niej — dalsze sekcje widzą tę samą pulę co bez niej.
        let messagesBefore = 0;
        beforeAll(async () => {
          messagesBefore = await readQuota(householdId);
          process.env.AI_LIMIT_MESSAGES_PER_MONTH = '100000';
        });
        afterAll(async () => {
          delete process.env.AI_LIMIT_MESSAGES_PER_MONTH;
          await prisma.aiUsageCounter.updateMany({
            where: {
              scopeId: householdId,
              periodKey: monthKey(),
              kind: 'messages',
            },
            data: { value: messagesBefore },
          });
        });

        /** Plan z R, propozycja podmienia na N (`recipeId`) i CZEKA na klik. */
        const preparePending = async (who: Session = session) => {
          await prisma.weeklyPlan.deleteMany({
            where: { householdId, weekStart: weekStartDate },
          });
          await prisma.weeklyPlan.create({
            data: {
              householdId,
              weekStart: weekStartDate,
              items: {
                create: [
                  { dayOfWeek: 'MON', mealType: 'DINNER', recipeId: before },
                ],
              },
            },
          });
          const conversation = await createConversation(
            who.accessToken,
            householdId,
          );
          const accepted = await postMessage(who.accessToken, conversation.id, {
            clientMessageId: randomUUID(),
            text: `Podmień kolację [[propose:${recipeId}:${WEEK_START}]]`,
            clientCapabilities: [CARDS_CAPABILITY_V1],
          }).expect(202);
          await pollTurn(
            who.accessToken,
            (accepted.body as AcceptedTurn).turnId,
          );
          const proposalRow = await prisma.agentProposal.findFirstOrThrow({
            where: { conversationId: conversation.id },
          });
          const proposalId = proposalRow.id;
          const plan = await counters.resolvePlan(householdId, {
            userId: who.user.id,
          });
          const plansUsed = async () =>
            (
              await prisma.aiUsageCounter.findUnique({
                where: {
                  scopeId_periodKey_kind: {
                    scopeId: plan.quotaScopeId,
                    periodKey: plan.periodKey,
                    kind: 'plans',
                  },
                },
              })
            )?.value ?? 0;
          const appliedMessages = () =>
            prisma.agentMessage.count({
              where: { conversationId: conversation.id, kind: 'APPLIED' },
            });
          const apply = (body: Record<string, unknown> = {}) =>
            request(app.getHttpServer())
              .post(`/agent/proposals/${proposalId}/apply`)
              .set(auth(who.accessToken))
              .send(body);
          const proposal = () =>
            prisma.agentProposal.findUnique({ where: { id: proposalId } });
          return {
            conversation,
            proposalId,
            apply,
            proposal,
            plansUsed,
            appliedMessages,
            usedBefore: await plansUsed(),
          };
        };

        /** Nic z zapisu nie zapadło: plan, propozycja, kwota i rozmowa. */
        const expectUntouched = async (
          ctx: Awaited<ReturnType<typeof preparePending>>,
          status: string,
        ) => {
          expect(await planRecipes()).toEqual([`MON:DINNER:${before}`]);
          expect(await ctx.proposal()).toMatchObject({
            status,
            appliedAt: null,
            appliedHash: null,
            undoSnapshot: null,
            quotaPeriodKey: null,
          });
          expect(await ctx.plansUsed()).toBe(ctx.usedBefore);
          expect(await ctx.appliedMessages()).toBe(0);
        };

        it('F: sukces jednej propozycji — plan, APPLIED, jedna kwota, jedno potwierdzenie; ponowny klik niczego nie dokłada', async () => {
          const ctx = await preparePending();

          const res = await ctx.apply().expect(200);
          expect(res.body).toMatchObject({
            proposalId: ctx.proposalId,
            status: 'APPLIED',
            message: { kind: 'APPLIED' },
          });
          expect(await planRecipes()).toEqual([`MON:DINNER:${recipeId}`]);
          const row = await ctx.proposal();
          // Podmiana dania to usunięcie starej pozycji i utworzenie nowej.
          expect(row).toMatchObject({ status: 'APPLIED', changedCount: 2 });
          expect(row!.appliedHash).toEqual(expect.any(String));
          expect(row!.undoSnapshot).toEqual([
            expect.objectContaining({ recipeId: before }),
          ]);
          expect(await ctx.plansUsed()).toBe(ctx.usedBefore + 1);
          expect(await ctx.appliedMessages()).toBe(1);

          // Ponowne apply po sukcesie: ten sam wynik, zero skutków.
          const again = await ctx.apply().expect(200);
          expect(again.body).toMatchObject({
            status: 'APPLIED',
            message: {
              id: (res.body as { message: { id: string } }).message.id,
            },
          });
          expect(await ctx.plansUsed()).toBe(ctx.usedBefore + 1);
          expect(await ctx.appliedMessages()).toBe(1);
          expect(await ctx.proposal()).toMatchObject({
            appliedAt: row!.appliedAt,
            appliedHash: row!.appliedHash,
          });
        });

        it('G: dwa zapisy zwolnione z bariery naraz — jeden zapis, jedna kwota, jedno potwierdzenie', async () => {
          const ctx = await preparePending();
          const hold = holdApplyWeekPlan(2);

          const first = ctx.apply().then((res) => res);
          const second = ctx.apply().then((res) => res);
          // Oba przeszły kontrole wstępne na PENDING i stoją przed zapisem.
          await hold.allArrived();
          hold.release();
          const results = await Promise.all([first, second]);

          expect(results.map((res) => res.status)).toEqual([200, 200]);
          expect(
            results.map((res) => (res.body as { status: string }).status),
          ).toEqual(['APPLIED', 'APPLIED']);
          expect(await planRecipes()).toEqual([`MON:DINNER:${recipeId}`]);
          const row = await ctx.proposal();
          expect(row).toMatchObject({ status: 'APPLIED', changedCount: 2 });
          // „Stan sprzed" to tydzień sprzed PIERWSZEGO zapisu, nie już zmieniony.
          expect(row!.undoSnapshot).toEqual([
            expect.objectContaining({ recipeId: before }),
          ]);
          expect(await ctx.plansUsed()).toBe(ctx.usedBefore + 1);
          expect(await ctx.appliedMessages()).toBe(1);
        });

        describe('domownik wyrzucony przed zatwierdzeniem', () => {
          let member: Session;

          beforeEach(async () => {
            member = await devLogin('Domownik');
            await prisma.membership.create({
              data: { userId: member.user.id, householdId, role: 'MEMBER' },
            });
          });

          afterEach(async () => {
            await prisma.membership.deleteMany({
              where: { userId: member.user.id, householdId },
            });
          });

          const removeMember = () =>
            app
              .get(HouseholdsService)
              .removeMember(session.user.id, householdId, member.user.id);

          it('H: wyrzucony PRZED kliknięciem — 403, nic nie zapada', async () => {
            const ctx = await preparePending(member);
            await removeMember();

            const res = await ctx.apply();

            expect(res.status).toBe(403);
            expect(res.body).toMatchObject({ code: 'NOT_HOUSEHOLD_MEMBER' });
            await expectUntouched(ctx, 'PENDING');
          });

          it('I: wyrzucony W TRAKCIE zapisu (po kontrolach wstępnych) — plan nietknięty, propozycja nie APPLIED, kwota bez zmian', async () => {
            const ctx = await preparePending(member);
            const hold = holdApplyWeekPlan(1);

            const late = ctx.apply().then((res) => res);
            // Kontrola członkostwa w `apply` już przeszła.
            await hold.allArrived();
            await removeMember();
            hold.release();
            const res = await late;

            expect(res.status).toBe(403);
            expect(res.body).toMatchObject({ code: 'NOT_HOUSEHOLD_MEMBER' });
            await expectUntouched(ctx, 'PENDING');
          });
        });

        it('J: awaria techniczna W transakcji (po zapisie pozycji) — 500, wszystko wycofane, FAILED; ponowienie zapisuje raz', async () => {
          const ctx = await preparePending();
          const shopping = app.get(ShoppingListService);
          const original = shopping.markShoppingListStale.bind(shopping);
          let failed = false;
          jest
            .spyOn(shopping, 'markShoppingListStale')
            .mockImplementation((...args) => {
              if (!failed) {
                failed = true;
                return Promise.reject(new Error('baza padła'));
              }
              return original(...args);
            });

          await ctx.apply().expect(500);
          expect(failed).toBe(true);
          await expectUntouched(ctx, 'FAILED');

          // FAILED = „Spróbuj ponownie": zwykły klik, bez `force`.
          await ctx.apply().expect(200);
          expect(await planRecipes()).toEqual([`MON:DINNER:${recipeId}`]);
          expect(await ctx.proposal()).toMatchObject({ status: 'APPLIED' });
          expect(await ctx.plansUsed()).toBe(ctx.usedBefore + 1);
          expect(await ctx.appliedMessages()).toBe(1);
        });

        it('K: awaria licznika kwoty W transakcji — 500, plan i propozycja wycofane, kwota bez zmian', async () => {
          const ctx = await preparePending();
          jest
            .spyOn(counters, 'tryConsume')
            .mockRejectedValueOnce(new Error('licznik padł'));

          await ctx.apply().expect(500);
          await expectUntouched(ctx, 'FAILED');
        });

        it('L: pytanie poprawione po propozycji — STALE; zwykły klik i „Zapisz mimo to" odmawiają, nic nie zapada', async () => {
          const ctx = await preparePending();
          const question = await prisma.agentMessage.findFirstOrThrow({
            where: { conversationId: ctx.conversation.id, role: 'USER' },
          });

          const edited = await request(app.getHttpServer())
            .post(`/agent/conversations/${ctx.conversation.id}/messages/edit`)
            .set(auth(session.accessToken))
            .send({
              messageId: question.id,
              clientMessageId: randomUUID(),
              text: 'Jednak nic nie zmieniaj',
              weekStart: WEEK_START,
              clientToday: CLIENT_TODAY,
              timeZone: TIME_ZONE,
              clientCapabilities: [CARDS_CAPABILITY_V1],
            })
            .expect(202);
          await pollTurn(
            session.accessToken,
            (edited.body as AcceptedTurn).turnId,
          );
          expect(await ctx.proposal()).toMatchObject({ status: 'STALE' });

          // Plan jest DOKŁADNIE taki, jak przy propozycji — odcisk się zgadza,
          // więc to status i ukryte pytanie muszą zatrzymać zapis.
          const plain = await ctx.apply().expect(409);
          expect(plain.body).toMatchObject({
            code: 'AI_PROPOSAL_STALE',
            details: ['reason:STALE'],
          });
          const forced = await ctx.apply({ force: true }).expect(409);
          expect(forced.body).toMatchObject({
            code: 'AI_PROPOSAL_STALE',
            details: ['reason:WITHDRAWN'],
          });
          await expectUntouched(ctx, 'STALE');
        });
      });
    });

    it('klient bez `cards.v1` nie dostaje propozycji, której nie umie pokazać', async () => {
      const conversation = await createConversation(
        session.accessToken,
        householdId,
      );
      const accepted = await postMessage(session.accessToken, conversation.id, {
        clientMessageId: randomUUID(),
        text: `Ułóż tydzień [[propose:${recipeId}:${WEEK_START}]]`,
      }).expect(202);

      const done = await pollTurn(
        session.accessToken,
        (accepted.body as AcceptedTurn).turnId,
      );
      // Tura kończy się NORMALNIE: narzędzie spoza trybu odmawia jako dane,
      // więc stary build dostaje zdanie zamiast błędu.
      expect(done.status).toBe('DONE');

      const messages = await history(conversation.id);
      const assistant = messages[messages.length - 1];
      expect(assistant.kind).toBe('TEXT');
      expect(assistant.card).toBeNull();
      expect(await weekItems()).toBe(0);
    });
  });

  // Poprawka to nowa tura, a nie zmiana tekstu w miejscu. Sedno: to, co było
  // po poprawianym pytaniu, znika — i z ekranu, i z historii dla modelu.
  describe('poprawianie pytania', () => {
    const editMessage = (
      token: string,
      conversationId: string,
      body: Record<string, unknown>,
    ) =>
      request(app.getHttpServer())
        .post(`/agent/conversations/${conversationId}/messages/edit`)
        .set(auth(token))
        .send({
          weekStart: WEEK_START,
          clientToday: CLIENT_TODAY,
          timeZone: TIME_ZONE,
          ...body,
        });

    const history = async (conversationId: string) => {
      const res = await request(app.getHttpServer())
        .get(`/agent/conversations/${conversationId}/messages`)
        .set(auth(session.accessToken))
        .expect(200);
      return (res.body as { messages: { id: string; text: string }[] })
        .messages;
    };

    it('wycofuje pytanie i odpowiedź na nie, a potem pyta od nowa', async () => {
      const conversation = await createConversation(
        session.accessToken,
        householdId,
      );
      const first = await postMessage(session.accessToken, conversation.id, {
        clientMessageId: randomUUID(),
        text: 'Co na obiad w piątek?',
      }).expect(202);
      await pollTurn(session.accessToken, (first.body as AcceptedTurn).turnId);

      const before = await history(conversation.id);
      expect(before).toHaveLength(2);
      const original = before[0];

      const edited = await editMessage(session.accessToken, conversation.id, {
        clientMessageId: randomUUID(),
        messageId: original.id,
        text: 'Co na kolację w piątek?',
      }).expect(202);
      await pollTurn(session.accessToken, (edited.body as AcceptedTurn).turnId);

      const after = await history(conversation.id);
      // Rozmowa ma dwie wiadomości: poprawione pytanie i nowa odpowiedź.
      expect(after).toHaveLength(2);
      expect(after[0].text).toBe('Co na kolację w piątek?');
      expect(after.some((message) => message.id === original.id)).toBe(false);
      // Odpowiedź jest na NOWE pytanie, nie na wycofane.
      expect(after[1].text).toContain('Co na kolację w piątek?');
    });

    it('cudza wiadomość: 404, nie cicha poprawka', async () => {
      const other = await devLogin('Obcy');
      const otherHousehold = await createHousehold(other.user.id, 'Obcy dom');
      const mine = await createConversation(session.accessToken, householdId);
      const sent = await postMessage(session.accessToken, mine.id, {
        clientMessageId: randomUUID(),
        text: 'Moje pytanie',
      }).expect(202);
      await pollTurn(session.accessToken, (sent.body as AcceptedTurn).turnId);
      const messages = await history(mine.id);

      const theirs = await createConversation(
        other.accessToken,
        otherHousehold,
      );
      await editMessage(other.accessToken, theirs.id, {
        clientMessageId: randomUUID(),
        messageId: messages[0].id,
        text: 'Podmieniam cudze',
      }).expect(404);
    });

    it('odpowiedź asystenta nie jest „własnym pytaniem”', async () => {
      const conversation = await createConversation(
        session.accessToken,
        householdId,
      );
      const sent = await postMessage(session.accessToken, conversation.id, {
        clientMessageId: randomUUID(),
        text: 'Pytanie',
      }).expect(202);
      await pollTurn(session.accessToken, (sent.body as AcceptedTurn).turnId);
      const messages = await history(conversation.id);
      const assistantMessage = messages[1];

      const res = await editMessage(session.accessToken, conversation.id, {
        clientMessageId: randomUUID(),
        messageId: assistantMessage.id,
        text: 'Nie tak miałeś powiedzieć',
      }).expect(404);
      expect((res.body as { code: string }).code).toBe('AI_MESSAGE_NOT_FOUND');

      // Nic nie zniknęło: nieudana poprawka nie rusza rozmowy.
      expect(await history(conversation.id)).toHaveLength(2);
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
