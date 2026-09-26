import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { AgentCatalogService } from '../src/agent/search/agent-catalog.service';
import { StubAgentProvider } from '../src/agent/providers/stub-agent.provider';
import { AgentProviderRequest } from '../src/agent/providers/agent-provider';
import { CARDS_CAPABILITY_V1 } from '../src/agent/cards/agent-cards';

/**
 * Stan kart w kolejnych turach (workstream, Etap 1) — na żywej bazie,
 * z dostawcą `stub` i markerami `[[options:…]]`, `[[propose:…]]`,
 * `[[revise:…]]`. Szpieg na stubie pokazuje, co MODEL dostał w historii.
 *
 * Przed poprawką historia niosła sam tekst wiadomości: „wybieram drugą" nie
 * miało do czego się odnieść, a „zamień tylko wtorek" dało się zrobić tylko
 * nową propozycją od zera, odtwarzaną z pamięci modelu.
 */
type Session = {
  accessToken: string;
  user: { id: string };
  household: { id: string } | null;
};

const WEEK_START = '2026-08-31';
const CLIENT_TODAY = '2026-09-02';

describe('Asystent: stan kart w kolejnych turach E2E', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let runSpy: jest.SpyInstance;
  let session: Session;
  let householdId: string;
  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];
  /** Trzy kolacje z katalogu: id, indeks `R…` i tytuł. */
  let dinners: { id: string; ref: string; title: string }[] = [];

  const ENV_KEYS = [
    'AI_ENABLED',
    'AI_PROVIDER',
    'AI_STUB_DELAY_MS',
    'AI_TIER_OVERRIDE',
    'AI_CONSENT_REQUIRED',
    'AI_CARDS_MODE',
    'THROTTLE_DEFAULT_LIMIT',
    'THROTTLE_IP_LIMIT',
    'THROTTLE_AGENT_MESSAGE_LIMIT',
    'THROTTLE_AGENT_POLL_LIMIT',
  ] as const;
  const original: Record<string, string | undefined> = {};
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  const createConversation = async () => {
    const res = await request(app.getHttpServer())
      .post('/agent/conversations')
      .set(auth(session.accessToken))
      .send({ householdId })
      .expect(201);
    return (res.body as { id: string }).id;
  };

  /** Wysyła wiadomość i czeka na domknięcie tury; oddaje, co dostał model. */
  const turn = async (conversationId: string, text: string) => {
    const accepted = await request(app.getHttpServer())
      .post(`/agent/conversations/${conversationId}/messages`)
      .set(auth(session.accessToken))
      .send({
        text,
        clientMessageId: randomUUID(),
        weekStart: WEEK_START,
        clientToday: CLIENT_TODAY,
        timeZone: 'Europe/Warsaw',
        clientCapabilities: [CARDS_CAPABILITY_V1],
      })
      .expect(202);
    const turnId = (accepted.body as { turnId: string }).turnId;
    const deadline = Date.now() + 10_000;
    for (;;) {
      const row = await prisma.agentTurn.findUniqueOrThrow({
        where: { id: turnId },
      });
      if (row.status !== 'RUNNING') {
        expect(row.status).toBe('DONE');
        break;
      }
      if (Date.now() > deadline) throw new Error(`tura ${turnId} wisi`);
      await sleep(100);
    }
    const seen = (runSpy.mock.calls.at(-1) as [AgentProviderRequest])[0];
    const answer = await prisma.agentMessage.findFirstOrThrow({
      where: { turnId, role: 'ASSISTANT' },
    });
    return { turnId, seen, answer };
  };

  beforeAll(async () => {
    for (const key of ENV_KEYS) original[key] = process.env[key];
    process.env.AI_ENABLED = 'true';
    process.env.AI_PROVIDER = 'stub';
    process.env.AI_STUB_DELAY_MS = '0';
    process.env.AI_TIER_OVERRIDE = 'PRO';
    process.env.AI_CONSENT_REQUIRED = 'false';
    process.env.AI_CARDS_MODE = 'soft';
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
    runSpy = jest.spyOn(app.get(StubAgentProvider), 'run');

    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `Karty ${stamp}`,
        email: `karty-${stamp}@cards.local`,
      })
      .expect(201);
    session = res.body as Session;
    createdUserIds.push(session.user.id);
    if (session.household) createdHouseholdIds.push(session.household.id);
    const household = await prisma.household.create({
      data: { name: `Karty ${stamp}`, createdById: session.user.id },
    });
    await prisma.membership.create({
      data: {
        userId: session.user.id,
        householdId: household.id,
        role: 'OWNER',
      },
    });
    householdId = household.id;
    createdHouseholdIds.push(household.id);

    // Kolacje z INDEKSU tury — tylko dla nich model zna numer `R…`.
    const { digest } = await app.get(AgentCatalogService).snapshot();
    const refById = new Map(
      Object.entries(digest.index).map(([ref, id]) => [id, ref]),
    );
    const rows = await prisma.recipe.findMany({
      where: {
        id: { in: [...refById.keys()] },
        suitableMealTypes: { has: 'DINNER' },
        allergens: { isEmpty: true },
      },
      select: { id: true, title: true },
      orderBy: { title: 'asc' },
      take: 3,
    });
    if (rows.length < 3) throw new Error('katalog nie ma trzech kolacji');
    dinners = rows.map((row) => ({ ...row, ref: refById.get(row.id)! }));
  });

  afterAll(async () => {
    runSpy.mockRestore();
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

  it('rozmowa wieloturowa z wyborem: „wybieram drugą" widzi kafelki w kolejności', async () => {
    const conversationId = await createConversation();
    const [a, b] = dinners;
    const first = await turn(
      conversationId,
      `Co na kolację? [[options:${a.id},${b.id}]]`,
    );
    expect(first.answer.kind).toBe('OPTIONS');

    const second = await turn(conversationId, 'wybieram drugą');
    const options = second.seen.messages.find(
      (message) => message.role === 'ASSISTANT',
    );
    expect(options?.text).toContain(`1) ${a.ref} ${a.title}`);
    expect(options?.text).toContain(`2) ${b.ref} ${b.title}`);
    // Ostatnia wiadomość to prośba użytkownika — bez dopisków.
    expect(second.seen.messages.at(-1)).toEqual({
      role: 'USER',
      text: 'wybieram drugą',
    });
  });

  it('„zamień tylko wtorek": nowa propozycja z jedną zmienioną pozycją, reszta bez zmian', async () => {
    const conversationId = await createConversation();
    const [a, b, c] = dinners;
    const planned = await turn(
      conversationId,
      `Ułóż tydzień [[propose:${a.id}:${WEEK_START}]] [[propose:${b.id}:${WEEK_START}]]`,
    );
    expect(planned.answer.kind).toBe('PLAN_WEEK');
    const firstId = (planned.answer.card as { proposalId: string }).proposalId;

    const revised = await turn(
      conversationId,
      `zamień tylko wtorek [[revise:${firstId}:TUE:DINNER:${c.id}]]`,
    );

    // Model widział propozycję: numer, status z bazy i obie pozycje.
    const shown = revised.seen.messages.find(
      (message) => message.role === 'ASSISTANT',
    );
    expect(shown?.text).toContain(`${firstId} status=PENDING`);
    expect(shown?.text).toContain(`MON DINNER ${a.ref} ${a.title}`);
    expect(shown?.text).toContain(`TUE DINNER ${b.ref} ${b.title}`);

    // Tura kończy się NOWĄ kartą propozycji.
    expect(revised.answer.kind).toBe('PLAN_WEEK');
    const secondId = (revised.answer.card as { proposalId: string }).proposalId;
    expect(secondId).not.toBe(firstId);

    const [before, after] = await Promise.all([
      prisma.agentProposal.findUniqueOrThrow({ where: { id: firstId } }),
      prisma.agentProposal.findUniqueOrThrow({ where: { id: secondId } }),
    ]);
    // Poniedziałek nietknięty, wtorek podmieniony — intencja, nie widok.
    expect((after.action as { slots: unknown[] }).slots).toEqual([
      { dayOfWeek: 'MON', mealType: 'DINNER', recipeId: a.id },
      { dayOfWeek: 'TUE', mealType: 'DINNER', recipeId: c.id },
    ]);
    // Starej nie oznaczamy — odcisk planu i tak zrobi z niej STALE po zapisie.
    expect(before.status).toBe('PENDING');
    expect(after.messageId).toBe(revised.answer.id);

    // Zapis poprawionej propozycji: dokładnie dwie pozycje, z wtorkiem C.
    await request(app.getHttpServer())
      .post(`/agent/proposals/${secondId}/apply`)
      .set(auth(session.accessToken))
      .expect(200);
    const items = await prisma.planItem.findMany({
      where: { weeklyPlan: { householdId } },
      select: { dayOfWeek: true, recipeId: true },
      orderBy: { dayOfWeek: 'asc' },
    });
    expect(items).toEqual([
      { dayOfWeek: 'MON', recipeId: a.id },
      { dayOfWeek: 'TUE', recipeId: c.id },
    ]);
    // Pierwsza wersja przestała pasować do planu — zatwierdzenie to 409.
    await request(app.getHttpServer())
      .post(`/agent/proposals/${firstId}/apply`)
      .set(auth(session.accessToken))
      .expect(409);
  });
});
