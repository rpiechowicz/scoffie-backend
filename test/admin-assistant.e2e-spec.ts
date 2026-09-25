import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes, randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { netRevenuePln } from '../src/config/ai-unit-economics';
import type { AgentReport, ProfitData } from '../src/admin/contract';
import { PASTE_AFTER_ANONYMIZATION } from '../src/admin/assistant/report-scenario';
import {
  addDays,
  warsawDateKey,
  warsawDayStart,
} from '../src/admin/common/warsaw-calendar';
import {
  cleanupAdmins,
  createAdminSession,
  useAdminDevGate,
  type AdminE2ESession,
} from './admin-e2e.helper';

/**
 * Panel administratora — asystent: rentowność per zakres puli, kolejka
 * zgłoszeń, decyzja moderatora i scenariusz benchmarku. Na żywej bazie.
 *
 * Agregaty rentowności liczą CAŁĄ bazę, więc asercje idą na PRZYROSTACH
 * względem odczytu sprzed seeda (cudze dane w bazie ich nie psują). Wartości
 * bezwzględne (p50/p95, trend) — tylko gdy baza była pusta w tym oknie.
 */
describe('Panel administratora — asystent (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let restoreEnv: () => void;
  let session: AdminE2ESession;

  const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const SOLO = 'app.scoffie.pro.solo.monthly';
  const DUET = 'app.scoffie.pro.duet.monthly';
  const SONNET = 'claude-sonnet-5';
  const HAIKU = 'claude-haiku-4-5';
  const DAILY = netRevenuePln(29.99) / 30;

  const userIds: string[] = [];
  const householdIds: string[] = [];
  const subscriptionIds: string[] = [];
  const usageIds: string[] = [];

  const now = new Date();
  const ago = (days: number, hours = 0) =>
    new Date(now.getTime() - days * 86_400_000 - hours * 3_600_000);

  let baseline7: ProfitData;
  let baseline30: ProfitData;

  const ids = {
    payer: '',
    trialUser: '',
    otherUser: '',
    h1: '',
    h2: '',
    h3: '',
    s1: '',
    s2: '',
    t1: '',
    t3: '',
    r1: '',
    r2: '',
    r3: '',
    r4: '',
  };
  const R1_TEXT =
    'Na jutro proponuję owsiankę z bananem i masłem orzechowym — 610 kcal.';

  const server = () => app.getHttpServer();
  const profit = async (period: string) =>
    (
      await request(server())
        .get(`/admin/assistant/profit?period=${period}`)
        .set('Cookie', session.cookie)
        .expect(200)
    ).body as ProfitData;

  const createUser = async (label: string) => {
    const user = await prisma.user.create({
      data: {
        displayName: `${label} ${stamp}`,
        email: `${label.toLowerCase()}-${stamp}@admin-a3.local`,
        authProvider: 'DEV',
      },
      select: { id: true },
    });
    userIds.push(user.id);
    return user.id;
  };

  const createHousehold = async (name: string, ownerId: string) => {
    const household = await prisma.household.create({
      data: {
        name: `${name} ${stamp}`,
        createdById: ownerId,
        memberships: { create: [{ userId: ownerId, role: 'OWNER' }] },
      },
      select: { id: true },
    });
    householdIds.push(household.id);
    return household.id;
  };

  const createTurn = (data: {
    conversationId: string;
    userId: string;
    scope: string;
    status: string;
    createdAt: Date;
    durationMs?: number;
    errorCode?: string;
    model?: string;
  }) =>
    prisma.agentTurn.create({
      data: {
        conversationId: data.conversationId,
        userId: data.userId,
        userMessageId: randomUUID(),
        requestId: `a3-${stamp}`,
        status: data.status,
        quotaScopeId: data.scope,
        provider: 'stub',
        model: data.model ?? SONNET,
        durationMs: data.durationMs ?? null,
        errorCode: data.errorCode ?? null,
        createdAt: data.createdAt,
        startedAt: data.createdAt,
        finishedAt: data.status === 'RUNNING' ? null : data.createdAt,
      },
      select: { id: true },
    });

  const addUsage = async (data: {
    turnId: string | null;
    userId: string;
    householdId: string;
    model: string;
    costMicroUsd: number;
    createdAt: Date;
  }) => {
    const row = await prisma.aiUsage.create({
      data: { ...data, provider: 'stub' },
      select: { id: true },
    });
    usageIds.push(row.id);
  };

  const addProposal = (data: {
    conversationId: string;
    turnId: string;
    userId: string;
    householdId: string;
    status: string;
    createdAt: Date;
  }) =>
    prisma.agentProposal.create({
      data: {
        ...data,
        kind: 'PLAN_WEEK',
        weekStart: new Date('2026-09-21T00:00:00.000Z'),
        action: {},
        card: {},
        baselineHash: `a3-${stamp}`,
        expiresAt: new Date(now.getTime() + 86_400_000),
      },
    });

  beforeAll(async () => {
    restoreEnv = useAdminDevGate();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    session = await createAdminSession(prisma, { stepUp: true });

    // Stan sprzed seeda — asercje idą na przyrostach.
    baseline7 = await profit('7');
    baseline30 = await profit('30');

    ids.payer = await createUser('Platnik');
    ids.trialUser = await createUser('Proba');
    ids.otherUser = await createUser('Sandbox');
    ids.h1 = await createHousehold('Dom płatnika', ids.payer);
    ids.h2 = await createHousehold('Dom próby', ids.trialUser);
    ids.h3 = await createHousehold('Dom testera', ids.otherUser);

    // S1: prawdziwe pieniądze (Apple, produkcja, zakup) od 40 dni — kupiona
    // w południe polskiego dnia, żeby liczba opłaconych dni była jednoznaczna.
    const s1 = await prisma.subscription.create({
      data: {
        identityHash: `a3-hash-${stamp}-1`,
        purchaserUserId: ids.payer,
        provider: 'APPLE',
        productId: SOLO,
        originalTransactionId: `a3-${stamp}-1`,
        status: 'ACTIVE',
        environment: 'Production',
        ownershipType: 'PURCHASED',
        createdAt: new Date(
          warsawDayStart(addDays(warsawDateKey(now), -40)).getTime() +
            12 * 3_600_000,
        ),
        expiresAt: new Date(now.getTime() + 20 * 86_400_000),
      },
      select: { id: true },
    });
    ids.s1 = s1.id;
    subscriptionIds.push(s1.id);
    // S2: sandbox (TestFlight) bez konta płatnika — koszt prawdziwy,
    // przychodu brak, dom z ostatniej tury zakresu.
    const s2 = await prisma.subscription.create({
      data: {
        identityHash: `a3-hash-${stamp}-2`,
        purchaserUserId: null,
        provider: 'APPLE',
        productId: DUET,
        originalTransactionId: `a3-${stamp}-2`,
        status: 'ACTIVE',
        environment: 'Sandbox',
        ownershipType: 'PURCHASED',
        createdAt: ago(10),
        expiresAt: new Date(now.getTime() + 20 * 86_400_000),
      },
      select: { id: true },
    });
    ids.s2 = s2.id;
    subscriptionIds.push(s2.id);

    const c1 = await prisma.agentConversation.create({
      data: { userId: ids.payer, householdId: ids.h1 },
      select: { id: true },
    });
    const c2 = await prisma.agentConversation.create({
      data: { userId: ids.trialUser, householdId: ids.h2 },
      select: { id: true },
    });
    const c3 = await prisma.agentConversation.create({
      data: { userId: ids.otherUser, householdId: ids.h3 },
      select: { id: true },
    });
    const sub1 = `sub:${ids.s1}`;
    const sub2 = `sub:${ids.s2}`;
    const trial = `trial:a3-${stamp}`;

    // T1: przekazanie pałeczki Haiku → Sonnet (model startowy = Haiku).
    const t1 = await createTurn({
      conversationId: c1.id,
      userId: ids.payer,
      scope: sub1,
      status: 'DONE',
      durationMs: 5_000,
      model: HAIKU,
      createdAt: ago(1),
    });
    const t2 = await createTurn({
      conversationId: c1.id,
      userId: ids.payer,
      scope: sub1,
      status: 'DONE',
      durationMs: 12_000,
      createdAt: ago(2),
    });
    const t3 = await createTurn({
      conversationId: c1.id,
      userId: ids.payer,
      scope: sub1,
      status: 'FAILED',
      errorCode: 'AI_TIMEOUT',
      durationMs: 31_000,
      createdAt: ago(3),
    });
    const t4 = await createTurn({
      conversationId: c1.id,
      userId: ids.payer,
      scope: sub1,
      status: 'DONE',
      durationMs: 3_000,
      createdAt: ago(20),
    });
    const t5 = await createTurn({
      conversationId: c2.id,
      userId: ids.trialUser,
      scope: trial,
      status: 'DONE',
      durationMs: 7_000,
      model: HAIKU,
      createdAt: ago(1),
    });
    const t6 = await createTurn({
      conversationId: c3.id,
      userId: ids.otherUser,
      scope: sub2,
      status: 'DONE',
      durationMs: 9_000,
      model: HAIKU,
      createdAt: ago(1),
    });
    // Tura, której nikt nie domknął: liczy się do tur zakresu, nie do czasu.
    await createTurn({
      conversationId: c1.id,
      userId: ids.payer,
      scope: sub1,
      status: 'RUNNING',
      createdAt: ago(1),
    });
    ids.t1 = t1.id;
    ids.t3 = t3.id;

    const payerUsage = { userId: ids.payer, householdId: ids.h1 };
    await addUsage({
      ...payerUsage,
      turnId: t1.id,
      model: HAIKU,
      costMicroUsd: 10_000,
      createdAt: ago(1),
    });
    await addUsage({
      ...payerUsage,
      turnId: t1.id,
      model: SONNET,
      costMicroUsd: 50_000,
      createdAt: ago(1),
    });
    await addUsage({
      ...payerUsage,
      turnId: t2.id,
      model: SONNET,
      costMicroUsd: 100_000,
      createdAt: ago(2),
    });
    await addUsage({
      ...payerUsage,
      turnId: t3.id,
      model: SONNET,
      costMicroUsd: 20_000,
      createdAt: ago(3),
    });
    await addUsage({
      ...payerUsage,
      turnId: t4.id,
      model: SONNET,
      costMicroUsd: 200_000,
      createdAt: ago(20),
    });
    await addUsage({
      userId: ids.trialUser,
      householdId: ids.h2,
      turnId: t5.id,
      model: HAIKU,
      costMicroUsd: 30_000,
      createdAt: ago(1),
    });
    await addUsage({
      userId: ids.otherUser,
      householdId: ids.h3,
      turnId: t6.id,
      model: HAIKU,
      costMicroUsd: 40_000,
      createdAt: ago(1),
    });
    // Księga bez tury (rozmowa skasowana): koszt tak, tura i zakres — nie.
    await addUsage({
      ...payerUsage,
      turnId: null,
      model: SONNET,
      costMicroUsd: 5_000,
      createdAt: ago(1),
    });

    const proposal = {
      conversationId: c1.id,
      turnId: t1.id,
      userId: ids.payer,
      householdId: ids.h1,
    };
    await addProposal({ ...proposal, status: 'APPLIED', createdAt: ago(1) });
    await addProposal({ ...proposal, status: 'APPLIED', createdAt: ago(2) });
    await addProposal({ ...proposal, status: 'UNDONE', createdAt: ago(1) });
    await addProposal({ ...proposal, status: 'PENDING', createdAt: ago(1) });
    await addProposal({ ...proposal, status: 'STALE', createdAt: ago(1) });
    await addProposal({ ...proposal, status: 'EXPIRED', createdAt: ago(20) });

    const report = (data: {
      userId: string;
      turnId: string | null;
      reason: string;
      comment: string | null;
      messageText: string;
      createdAt: Date;
    }) => prisma.agentReport.create({ data, select: { id: true } });
    ids.r1 = (
      await report({
        userId: ids.payer,
        turnId: t1.id,
        reason: 'WRONG',
        comment: 'Owsianka ma 380 kcal, a nie 610.',
        messageText: R1_TEXT,
        createdAt: ago(0, 1),
      })
    ).id;
    // Tura skasowana retencją: `turnId` wskazuje w próżnię.
    ids.r2 = (
      await report({
        userId: ids.payer,
        turnId: randomUUID(),
        reason: 'UNSAFE',
        comment: null,
        messageText: 'Pesto z orzeszkami piniowymi.',
        createdAt: ago(0, 2),
      })
    ).id;
    ids.r3 = (
      await report({
        userId: ids.trialUser,
        turnId: null,
        reason: 'OTHER',
        comment: null,
        messageText: 'Dorsz z ziemniakami.',
        createdAt: ago(0, 3),
      })
    ).id;
    ids.r4 = (
      await report({
        userId: ids.payer,
        turnId: t3.id,
        reason: 'OFFENSIVE',
        comment: 'Nie na temat.',
        messageText: 'Pierogi ruskie: 500 g mąki…',
        createdAt: ago(0, 4),
      })
    ).id;
  });

  afterAll(async () => {
    if (prisma) {
      // Księga kosztów przeżywa kasowanie tur (SetNull) — sprzątamy ją jawnie.
      await prisma.aiUsage.deleteMany({ where: { id: { in: usageIds } } });
      await prisma.subscription.deleteMany({
        where: { id: { in: subscriptionIds } },
      });
      // Domy zabierają kaskadą rozmowy, tury i propozycje; konta — zgłoszenia.
      await prisma.household.deleteMany({
        where: { id: { in: householdIds } },
      });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await cleanupAdmins(prisma);
    }
    await app?.close();
    restoreEnv?.();
  });

  const histogramDelta = (after: ProfitData, before: ProfitData) =>
    Object.fromEntries(
      after.turnHistogram.map((entry, index) => [
        entry.bucket,
        entry.count - (before.turnHistogram[index]?.count ?? 0),
      ]),
    );
  const modelDelta = (after: ProfitData, before: ProfitData, model: string) => {
    const a = after.models.find((entry) => entry.model === model);
    const b = before.models.find((entry) => entry.model === model);
    return {
      turns: (a?.turns ?? 0) - (b?.turns ?? 0),
      costUsd: (a?.costUsd ?? 0) - (b?.costUsd ?? 0),
    };
  };
  const errorDelta = (after: ProfitData, before: ProfitData, code: string) =>
    (after.errors.find((entry) => entry.code === code)?.count ?? 0) -
    (before.errors.find((entry) => entry.code === code)?.count ?? 0);
  const sumOf = (
    data: ProfitData,
    field: 'revenueZl' | 'costUsd' | 'trialCostUsd',
  ) => data.days.reduce((total, day) => total + day[field], 0);
  const emptyBaseline = (data: ProfitData) =>
    data.turnHistogram.every((entry) => entry.count === 0) &&
    sumOf(data, 'revenueZl') === 0;

  describe('bez sesji panelu', () => {
    it('każda trasa asystenta to 404 jak brak trasy', async () => {
      await request(server()).get('/admin/assistant/profit').expect(404);
      await request(server()).get('/admin/assistant/reports').expect(404);
      await request(server())
        .patch(`/admin/assistant/reports/${randomUUID()}`)
        .send({ status: 'REVIEWED' })
        .expect(404);
      await request(server())
        .post(`/admin/assistant/reports/${randomUUID()}/scenario`)
        .send({})
        .expect(404);
    });
  });

  describe('GET /admin/assistant/profit', () => {
    it('7 dni: dzień po dniu, koszt, próby, propozycje, kubełki, modele, błędy', async () => {
      const data = await profit('7');

      expect(data.fxUsdPln).toBeCloseTo(3.7224, 4);
      expect(data.days).toHaveLength(7);
      const todayStart = warsawDayStart(warsawDateKey(new Date()));
      expect(data.days[6].date).toBe(todayStart.toISOString());

      // Koszt: T1 (0,06) + T2 + T3 + T5 + T6 + księga bez tury.
      expect(sumOf(data, 'costUsd') - sumOf(baseline7, 'costUsd')).toBeCloseTo(
        0.06 + 0.1 + 0.02 + 0.03 + 0.04 + 0.005,
        6,
      );
      expect(
        sumOf(data, 'trialCostUsd') - sumOf(baseline7, 'trialCostUsd'),
      ).toBeCloseTo(0.03, 6);
      // Przychód S1: 7 dni × netto/30 (dzienne kwoty zaokrąglone do groszy).
      expect(
        sumOf(data, 'revenueZl') - sumOf(baseline7, 'revenueZl'),
      ).toBeCloseTo(7 * DAILY, 1);

      expect(data.trials - baseline7.trials).toBe(1);

      const proposalsDelta = Object.fromEntries(
        Object.entries(data.proposals).map(([status, count]) => [
          status,
          count - baseline7.proposals[status as keyof typeof data.proposals],
        ]),
      );
      expect(proposalsDelta).toEqual({
        PENDING: 1,
        APPLIED: 2,
        UNDONE: 1,
        STALE: 1,
        EXPIRED: 0,
        FAILED: 0,
      });

      expect(data.turnHistogram.map((entry) => entry.bucket)).toEqual([
        '0–4',
        '4–6',
        '6–8',
        '8–10',
        '10–15',
        '15–20',
        '20–30',
        '30+',
      ]);
      // Tura RUNNING (bez czasu) nie wchodzi do histogramu.
      expect(histogramDelta(data, baseline7)).toEqual({
        '0–4': 0,
        '4–6': 1,
        '6–8': 1,
        '8–10': 1,
        '10–15': 1,
        '15–20': 0,
        '20–30': 0,
        '30+': 1,
      });
      if (emptyBaseline(baseline7)) {
        // 5 s, 7 s, 9 s, 12 s, 31 s — mediana 9 s, p95 = najdłuższa.
        expect(data.p50).toBe(9);
        expect(data.p95).toBe(31);
      }

      // Tura z przekazaniem pałeczki liczy się przy obu modelach.
      const sonnet = modelDelta(data, baseline7, SONNET);
      expect(sonnet.turns).toBe(3);
      expect(sonnet.costUsd).toBeCloseTo(0.05 + 0.1 + 0.02 + 0.005, 6);
      const haiku = modelDelta(data, baseline7, HAIKU);
      expect(haiku.turns).toBe(3);
      expect(haiku.costUsd).toBeCloseTo(0.01 + 0.03 + 0.04, 6);

      expect(errorDelta(data, baseline7, 'AI_TIMEOUT')).toBe(1);
      expect(data.errors.every((entry) => entry.code)).toBe(true);
    });

    it('wiersze per zakres subskrypcji: dom płatnika, produkt, przychód za okres', async () => {
      const data = await profit('7');
      const s1 = data.rows.find((row) => row.scopeId === `sub:${ids.s1}`);
      expect(s1).toEqual({
        scopeId: `sub:${ids.s1}`,
        householdId: ids.h1,
        householdName: `Dom płatnika ${stamp}`,
        productId: SOLO,
        revenueZl: Math.round(7 * DAILY * 100) / 100,
        costUsd: expect.any(Number) as number,
        turns: 4, // T1, T2, T3 i niedomknięta — T4 jest sprzed 20 dni
      });
      expect(s1?.costUsd).toBeCloseTo(0.06 + 0.1 + 0.02, 6);

      // Sandbox: koszt prawdziwy, przychodu brak; płatnika nie ma, więc dom
      // z ostatniej tury zakresu.
      const s2 = data.rows.find((row) => row.scopeId === `sub:${ids.s2}`);
      expect(s2).toMatchObject({
        householdId: ids.h3,
        householdName: `Dom testera ${stamp}`,
        productId: DUET,
        revenueZl: 0,
        turns: 1,
      });
      expect(s2?.costUsd).toBeCloseTo(0.04, 6);

      // Zakres próby to nie subskrypcja — do wierszy nie trafia.
      expect(data.rows.some((row) => row.scopeId.startsWith('trial:'))).toBe(
        false,
      );
    });

    it('30 dni: pełny miesiąc przychodu, starsza tura i trend wobec poprzednich 30 dni', async () => {
      const data = await profit('30');
      expect(data.days).toHaveLength(30);

      const s1 = data.rows.find((row) => row.scopeId === `sub:${ids.s1}`);
      expect(s1?.turns).toBe(5);
      expect(s1?.costUsd).toBeCloseTo(0.38, 6);
      expect(s1?.revenueZl).toBe(Math.round(netRevenuePln(29.99) * 100) / 100);

      expect(histogramDelta(data, baseline30)['0–4']).toBe(1);
      expect(data.proposals.EXPIRED - baseline30.proposals.EXPIRED).toBe(1);
      expect(modelDelta(data, baseline30, SONNET).turns).toBe(4);

      if (emptyBaseline(baseline30)) {
        // Poprzednie 30 dni: S1 kupiona 40 dni temu → 11 opłaconych dni.
        expect(data.revenueTrend).toBe(
          Math.round(((30 - 11) / 11) * 1000) / 10,
        );
      }
    });

    it('marża: trend w punktach procentowych liczony z przychodu i kosztu', async () => {
      // Okno 30 dni obejmuje też poprzednie 7 — musi być puste przed seedem.
      if (!emptyBaseline(baseline30)) return;
      const data = await profit('7');
      const fx = data.fxUsdPln;
      const revenue = 7 * DAILY;
      const cost = 0.06 + 0.1 + 0.02 + 0.03 + 0.04 + 0.005;
      const margin = ((revenue - cost * fx) / revenue) * 100;
      // Poprzednie 7 dni: pełny przychód S1, zero kosztu → marża 100 %.
      expect(data.revenueTrend).toBe(0);
      expect(Math.abs(data.marginTrendPp - (margin - 100))).toBeLessThan(0.06);
      expect(data.marginTrendPp).toBeLessThan(0);
    });

    it('„ten miesiąc” ma tyle dni, ile dzisiejsza data', async () => {
      const data = await profit('month');
      const today = warsawDateKey(new Date());
      expect(data.days).toHaveLength(Number(today.slice(8, 10)));
      expect(data.days[0].date).toBe(
        warsawDayStart(`${today.slice(0, 8)}01`).toISOString(),
      );
    });

    it('nieznany okres — 400', async () => {
      await request(server())
        .get('/admin/assistant/profit?period=90')
        .set('Cookie', session.cookie)
        .expect(400);
    });
  });

  describe('GET /admin/assistant/reports', () => {
    it('zgłoszenia z migawką, metadanymi tury albo `turn: null` po retencji', async () => {
      const res = await request(server())
        .get('/admin/assistant/reports')
        .set('Cookie', session.cookie)
        .expect(200);
      const list = res.body as AgentReport[];
      const byId = new Map(list.map((report) => [report.id, report]));

      expect(byId.get(ids.r1)).toEqual({
        id: ids.r1,
        userId: ids.payer,
        userName: `Platnik ${stamp}`,
        reason: 'WRONG',
        comment: 'Owsianka ma 380 kcal, a nie 610.',
        messageText: R1_TEXT,
        createdAt: expect.any(String) as string,
        turn: {
          // Start na Haiku, odpowiedź napisał Sonnet (planista).
          model: SONNET,
          costUsd: 0.06,
          durationMs: 5_000,
          status: 'DONE',
          errorCode: null,
        },
        status: 'NEW',
        testId: null,
      });
      expect(byId.get(ids.r2)?.turn).toBeNull();
      expect(byId.get(ids.r3)?.turn).toBeNull();
      expect(byId.get(ids.r4)?.turn).toEqual({
        model: SONNET,
        costUsd: 0.02,
        durationMs: 31_000,
        status: 'FAILED',
        errorCode: 'AI_TIMEOUT',
      });

      // Najnowsze pierwsze.
      const order = [ids.r1, ids.r2, ids.r3, ids.r4].map((id) =>
        list.findIndex((report) => report.id === id),
      );
      expect(order.every((index) => index >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(list.length).toBeLessThanOrEqual(200);
    });
  });

  describe('PATCH /admin/assistant/reports/:id', () => {
    const patch = (id: string, body: unknown) =>
      request(server())
        .patch(`/admin/assistant/reports/${id}`)
        .set('Cookie', session.cookie)
        .send(body as object);

    it('rozpatrzenie: status, kto i kiedy, wpis audytu z { from, to }', async () => {
      await patch(ids.r1, { status: 'REVIEWED' }).expect(204);
      const row = await prisma.agentReport.findUniqueOrThrow({
        where: { id: ids.r1 },
      });
      expect(row.status).toBe('REVIEWED');
      expect(row.reviewedAt).toBeInstanceOf(Date);
      expect(row.reviewedByAdminId).toBe(session.adminUserId);

      const audit = await prisma.adminAuditLog.findFirstOrThrow({
        where: { action: 'report.status.set', targetId: ids.r1 },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit).toMatchObject({
        result: 'SUCCESS',
        targetType: 'AgentReport',
        adminUserId: session.adminUserId,
        details: { from: 'NEW', to: 'REVIEWED' },
      });

      const list = (
        await request(server())
          .get('/admin/assistant/reports')
          .set('Cookie', session.cookie)
          .expect(200)
      ).body as AgentReport[];
      expect(list.find((report) => report.id === ids.r1)?.status).toBe(
        'REVIEWED',
      );
    });

    it('powrót do NEW czyści, kto i kiedy rozpatrzył', async () => {
      await patch(ids.r1, { status: 'NEW' }).expect(204);
      const row = await prisma.agentReport.findUniqueOrThrow({
        where: { id: ids.r1 },
      });
      expect(row).toMatchObject({
        status: 'NEW',
        reviewedAt: null,
        reviewedByAdminId: null,
      });
      const audit = await prisma.adminAuditLog.findFirstOrThrow({
        where: { action: 'report.status.set', targetId: ids.r1 },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit.details).toEqual({ from: 'REVIEWED', to: 'NEW' });
    });

    it('odrzucenie drugiego zgłoszenia', async () => {
      await patch(ids.r2, { status: 'DISMISSED' }).expect(204);
      expect(
        (await prisma.agentReport.findUniqueOrThrow({ where: { id: ids.r2 } }))
          .status,
      ).toBe('DISMISSED');
    });

    it('zły status, zły identyfikator, obce pole — 400; brak zgłoszenia — 404', async () => {
      await patch(ids.r3, { status: 'ACTIONED' }).expect(400);
      await patch(ids.r3, { status: 'REVIEWED', reason: 'coś' }).expect(400);
      await patch('nie-uuid', { status: 'REVIEWED' }).expect(400);
      const missing = randomUUID();
      const res = await patch(missing, { status: 'REVIEWED' }).expect(404);
      expect((res.body as { code: string }).code).toBe('NOT_FOUND');
      const audit = await prisma.adminAuditLog.findFirstOrThrow({
        where: { action: 'report.status.set', targetId: missing },
      });
      expect(audit).toMatchObject({ result: 'FAILED', errorCode: 'NOT_FOUND' });
    });
  });

  describe('POST /admin/assistant/reports/:id/scenario', () => {
    it('szkic scenariusza `pnpm agent:scenarios` — deterministyczny, z audytem', async () => {
      const res = await request(server())
        .post(`/admin/assistant/reports/${ids.r1}/scenario`)
        .set('Cookie', session.cookie)
        .send({})
        .expect(200);
      const body = res.body as {
        testId: string;
        scenario: {
          name: string;
          group: number;
          prompts: string[];
          reported: { messageText: string; model: string | null };
          source: string;
        };
      };
      const testId = `report-${ids.r1.slice(0, 8)}`;
      expect(body.testId).toBe(testId);
      expect(body.scenario).toMatchObject({
        name: testId,
        group: 10, // WRONG → liczby liczone przez serwer
        prompts: [],
        // Surowa treść zgłoszenia nie idzie do szkicu (ląduje w repo).
        reported: { messageText: PASTE_AFTER_ANONYMIZATION, model: SONNET },
      });
      expect(JSON.stringify(body)).not.toContain(R1_TEXT);
      expect(body.scenario.source).toContain(`name: "${testId}"`);
      expect(body.scenario.source).toContain('verify: (v) =>');

      const audit = await prisma.adminAuditLog.findFirstOrThrow({
        where: { action: 'report.scenario', targetId: ids.r1 },
      });
      expect(audit).toMatchObject({
        result: 'SUCCESS',
        details: { testId, group: 10 },
      });

      const again = await request(server())
        .post(`/admin/assistant/reports/${ids.r1}/scenario`)
        .set('Cookie', session.cookie)
        .send({})
        .expect(200);
      expect((again.body as { testId: string }).testId).toBe(testId);
    });

    it('zgłoszenie po retencji tury — szkic bez modelu', async () => {
      const res = await request(server())
        .post(`/admin/assistant/reports/${ids.r2}/scenario`)
        .set('Cookie', session.cookie)
        .send({})
        .expect(200);
      expect(res.body).toMatchObject({
        scenario: { group: 7, reported: { model: null } },
      });
    });

    it('brak zgłoszenia — 404', async () => {
      await request(server())
        .post(`/admin/assistant/reports/${randomUUID()}/scenario`)
        .set('Cookie', session.cookie)
        .send({})
        .expect(404);
    });
  });
});
