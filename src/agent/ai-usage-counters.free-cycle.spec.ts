import { PrismaService } from '../prisma/prisma.service';
import {
  AiUsageCountersService,
  freeCycle,
  freeQuotaRefusal,
  HouseholdPlan,
  TRIAL_PERIOD_KEY,
} from './ai-usage-counters.service';

/**
 * Darmowa pula wraca co `AI_TRIAL_RENEW_DAYS` dni od pierwszego użycia osoby
 * (od 7.10.2026; wcześniej była jednorazowa).
 */

const ANCHOR = new Date('2026-10-07T09:30:00.000Z');
const at = (days: number, hours = 0) =>
  new Date(ANCHOR.getTime() + (days * 24 + hours) * 60 * 60 * 1000);

describe('freeCycle', () => {
  it('bez kotwicy: pierwszy cykl `trial`, bez daty odnowienia', () => {
    expect(freeCycle(null, ANCHOR, 30)).toEqual({
      periodKey: TRIAL_PERIOD_KEY,
      resetsAt: null,
    });
  });

  it('pierwsze 30 dni to dalej `trial` — zużycie sprzed odnawiania liczy się', () => {
    expect(freeCycle(ANCHOR, at(29, 23), 30)).toEqual({
      periodKey: TRIAL_PERIOD_KEY,
      resetsAt: at(30).toISOString(),
    });
  });

  it('po 30 dniach nowy licznik z datą początku cyklu w kluczu', () => {
    expect(freeCycle(ANCHOR, at(30), 30)).toEqual({
      periodKey: 'free:2026-11-06',
      resetsAt: at(60).toISOString(),
    });
    expect(freeCycle(ANCHOR, at(75), 30)).toEqual({
      periodKey: 'free:2026-12-06',
      resetsAt: at(90).toISOString(),
    });
  });

  it('zegar przed kotwicą nie daje cyklu ujemnego', () => {
    expect(freeCycle(ANCHOR, at(-2), 30).periodKey).toBe(TRIAL_PERIOD_KEY);
  });

  it('AI_TRIAL_RENEW_DAYS=0 = pula jednorazowa jak dawniej', () => {
    expect(freeCycle(ANCHOR, at(400), 0)).toEqual({
      periodKey: TRIAL_PERIOD_KEY,
      resetsAt: null,
    });
  });
});

describe('resolvePlan — cykl darmowej puli', () => {
  const originals = { ...process.env };
  const HOUSE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const HASH = 'e'.repeat(64);
  let prisma: {
    household: { findUnique: jest.Mock };
    subscription: { findMany: jest.Mock };
    aiFreeQuotaCycle: { findUnique: jest.Mock; createMany: jest.Mock };
    aiUsageCounter: { findFirst: jest.Mock };
  };
  let counters: AiUsageCountersService;

  beforeEach(() => {
    process.env.AI_TIER_OVERRIDE = 'off';
    process.env.AI_TRIAL_MESSAGES = '5';
    process.env.AI_TRIAL_PLANS = '1';
    delete process.env.AI_TRIAL_RENEW_DAYS;
    prisma = {
      household: {
        findUnique: jest.fn().mockResolvedValue({
          tierOverride: null,
          memberships: [
            {
              userId: USER,
              user: {
                identityHash: HASH,
                appleSub: null,
                googleId: null,
                authProvider: 'APPLE',
              },
            },
          ],
        }),
      },
      subscription: { findMany: jest.fn().mockResolvedValue([]) },
      aiFreeQuotaCycle: {
        findUnique: jest.fn().mockResolvedValue(null),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      aiUsageCounter: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    counters = new AiUsageCountersService(prisma as unknown as PrismaService);
  });

  afterEach(() => {
    process.env = { ...originals };
  });

  it('nowa osoba: pula odnawialna, ale cykl jeszcze nie ruszył — bez kotwicy', async () => {
    const plan = await counters.resolvePlan(HOUSE, { userId: USER }, at(0));
    expect(plan).toMatchObject({
      tier: 'TRIAL',
      quotaScopeId: `trial:${HASH}`,
      periodKey: 'trial',
      renews: true,
      resetsAt: null,
    });
    expect(prisma.aiFreeQuotaCycle.createMany).not.toHaveBeenCalled();
  });

  it('pierwsze użycie bez kotwicy: kotwica = najstarszy zapis licznika', async () => {
    prisma.aiUsageCounter.findFirst.mockResolvedValue({ updatedAt: ANCHOR });
    prisma.aiFreeQuotaCycle.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ anchoredAt: ANCHOR });

    const plan = await counters.resolvePlan(HOUSE, { userId: USER }, at(1));
    expect(prisma.aiFreeQuotaCycle.createMany).toHaveBeenCalledWith({
      data: [{ scopeId: `trial:${HASH}`, anchoredAt: ANCHOR }],
      skipDuplicates: true,
    });
    expect(plan.periodKey).toBe('trial');
    expect(plan.resetsAt).toBe(at(30).toISOString());
  });

  it('równoległe żądanie wbiło kotwicę pierwsze — liczymy od JEGO daty', async () => {
    const earlier = at(-1);
    prisma.aiUsageCounter.findFirst.mockResolvedValue({ updatedAt: ANCHOR });
    prisma.aiFreeQuotaCycle.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ anchoredAt: earlier });
    const plan = await counters.resolvePlan(HOUSE, { userId: USER }, at(1));
    expect(plan.resetsAt).toBe(at(29).toISOString());
  });

  it('po 30 dniach od kotwicy: świeży licznik, data kolejnego odnowienia', async () => {
    prisma.aiFreeQuotaCycle.findUnique.mockResolvedValue({
      anchoredAt: ANCHOR,
    });
    const plan = await counters.resolvePlan(HOUSE, { userId: USER }, at(31));
    expect(plan.periodKey).toBe('free:2026-11-06');
    expect(plan.resetsAt).toBe(at(60).toISOString());
    expect(prisma.aiUsageCounter.findFirst).not.toHaveBeenCalled();
  });

  it('odnawianie wyłączone: jednorazowa pula, bez zapytań o kotwicę', async () => {
    process.env.AI_TRIAL_RENEW_DAYS = '0';
    const plan = await counters.resolvePlan(HOUSE, { userId: USER }, at(90));
    expect(plan).toMatchObject({
      periodKey: 'trial',
      renews: false,
      resetsAt: null,
    });
    expect(prisma.aiFreeQuotaCycle.findUnique).not.toHaveBeenCalled();
  });
});

describe('freeQuotaRefusal', () => {
  const plan = (resetsAt: string | null): HouseholdPlan => ({
    tier: 'TRIAL',
    source: 'TRIAL',
    quotaScopeId: 'trial:x',
    periodKey: 'trial',
    renews: resetsAt !== null,
    resetsAt,
    messagesLimit: 5,
    plansLimit: 1,
    product: null,
    subscriptionId: null,
  });

  it('mówi, kiedy pula wraca', () => {
    expect(freeQuotaRefusal('messages', plan('2026-11-06T09:30:00.000Z'))).toBe(
      'Darmowe wiadomości (5) są wykorzystane. Wrócą 6 listopada — albo wybierz plan, żeby mieć większą pulę dla całego domu.',
    );
    expect(freeQuotaRefusal('plans', plan('2026-11-06T09:30:00.000Z'))).toBe(
      'Darmowy zapis planu (1) jest wykorzystany. Wróci 6 listopada — albo wybierz plan, żeby mieć większą pulę dla całego domu.',
    );
  });

  it('bez odnowienia — tylko plan', () => {
    expect(freeQuotaRefusal('messages', plan(null))).toBe(
      'Darmowe wiadomości (5) są wykorzystane. Wybierz plan, żeby mieć pulę miesięczną dla całego domu.',
    );
  });
});
