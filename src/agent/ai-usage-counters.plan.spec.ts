import { PrismaService } from '../prisma/prisma.service';
import { purchaseIdentityHash } from '../config/purchase-identity';
import {
  AiUsageCountersService,
  pickBestSubscription,
  subscriptionAlive,
} from './ai-usage-counters.service';

/**
 * Uprawnienie do asystenta — jedyne miejsce, w którym rozstrzyga się, kto ma
 * PRO i z jakiej puli.
 *
 * Testy chodzą po pytaniach, które zadał Rafał, i po nadużyciach, które
 * znalazł audyt adwersarialny:
 *   • „user ma Solo i zaprasza domownika — czy domownik ma asystenta?"
 *   • „wyjdź z domu i załóż nowy" po świeżą pulę próbną,
 *   • przeprowadzka płatnika po świeżą pulę PRO,
 *   • zwrot pieniędzy, łaska płatnicza i subskrypcja bez daty końca.
 */

const NOW = new Date('2026-09-03T12:00:00.000Z');
const HOUSE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAYER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PAYER_HASH = 'd'.repeat(64);
const MEMBER_HASH = 'e'.repeat(64);

const sub = (over: Record<string, unknown> = {}) => ({
  id: 'sub-1',
  provider: 'APPLE',
  productId: 'app.scoffie.pro.solo.monthly',
  status: 'ACTIVE',
  expiresAt: new Date('2026-10-01T00:00:00.000Z'),
  graceExpiresAt: null,
  neverExpires: false,
  revokedAt: null,
  messagesLimitSnapshot: 30,
  plansLimitSnapshot: 8,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  ...over,
});

describe('subscriptionAlive', () => {
  it('aktywna z datą w przyszłości żyje', () => {
    expect(subscriptionAlive(sub(), NOW)).toBe(true);
  });

  it('zwrot pieniędzy ucina dostęp NATYCHMIAST, mimo statusu ACTIVE', () => {
    expect(
      subscriptionAlive(sub({ revokedAt: new Date('2026-09-02') }), NOW),
    ).toBe(false);
  });

  it('brak daty końca NIE znaczy „żywa na zawsze"', () => {
    // To był realny błąd poprzedniej wersji: `expiresAt === null` przechodziło
    // jako wieczne PRO. Wieczne bywa tylko nadanie ręczne.
    expect(subscriptionAlive(sub({ expiresAt: null }), NOW)).toBe(false);
    expect(
      subscriptionAlive(sub({ expiresAt: null, neverExpires: true }), NOW),
    ).toBe(true);
  });

  it('łaska płatnicza działa — i to jest cała różnica wobec EXPIRED', () => {
    const expired = new Date('2026-09-01T00:00:00.000Z');
    // Bez osobnej daty łaski status GRACE nigdy by nie zadziałał: `expiresAt`
    // z definicji leży już w przeszłości.
    expect(
      subscriptionAlive(
        sub({ status: 'GRACE', expiresAt: expired, graceExpiresAt: null }),
        NOW,
      ),
    ).toBe(true);
    expect(
      subscriptionAlive(
        sub({
          status: 'GRACE',
          expiresAt: expired,
          graceExpiresAt: new Date('2026-09-02T00:00:00.000Z'),
        }),
        NOW,
      ),
    ).toBe(false);
  });

  it('margines na zegar nie odcina klienta w sekundzie odnowienia', () => {
    const justExpired = new Date(NOW.getTime() - 60_000);
    expect(subscriptionAlive(sub({ expiresAt: justExpired }), NOW)).toBe(true);
    const longExpired = new Date(NOW.getTime() - 60 * 60_000);
    expect(subscriptionAlive(sub({ expiresAt: longExpired }), NOW)).toBe(false);
  });

  it('EXPIRED i REVOKED nie żyją niezależnie od dat', () => {
    expect(subscriptionAlive(sub({ status: 'EXPIRED' }), NOW)).toBe(false);
    expect(subscriptionAlive(sub({ status: 'REVOKED' }), NOW)).toBe(false);
  });
});

describe('pickBestSubscription', () => {
  it('ŻYWOTNOŚĆ przed limitem — martwa Rodzina nie zasłania żywego Solo', () => {
    // Inaczej wystarczyłoby kupić najdroższy plan i poprosić o zwrot, żeby
    // zablokować dom współdomownikowi, który płaci uczciwie.
    const winner = pickBestSubscription(
      [
        sub({
          id: 'martwa-rodzina',
          productId: 'app.scoffie.pro.family.monthly',
          messagesLimitSnapshot: 75,
          revokedAt: new Date('2026-09-01'),
        }),
        sub({ id: 'zywe-solo' }),
      ],
      NOW,
    );
    expect(winner?.id).toBe('zywe-solo');
  });

  it('wśród żywych wygrywa wyższy limit', () => {
    const winner = pickBestSubscription(
      [
        sub({ id: 'solo' }),
        sub({
          id: 'rodzina',
          productId: 'app.scoffie.pro.family.monthly',
          messagesLimitSnapshot: 75,
        }),
      ],
      NOW,
    );
    expect(winner?.id).toBe('rodzina');
  });

  it('przy remisie wygrywa starsza — wynik ma być stabilny', () => {
    const winner = pickBestSubscription(
      [
        sub({ id: 'nowsza', createdAt: new Date('2026-08-20') }),
        sub({ id: 'starsza', createdAt: new Date('2026-08-01') }),
      ],
      NOW,
    );
    expect(winner?.id).toBe('starsza');
  });

  it('sam nieznany produkt nie gubi limitu z migawki', () => {
    const winner = pickBestSubscription(
      [sub({ id: 'nowy-sku', productId: 'app.scoffie.pro.nowy.monthly' })],
      NOW,
    );
    expect(winner?.id).toBe('nowy-sku');
  });

  it('brak żywych daje `null`', () => {
    expect(pickBestSubscription([sub({ status: 'EXPIRED' })], NOW)).toBeNull();
    expect(pickBestSubscription([], NOW)).toBeNull();
  });
});

describe('resolvePlan — uprawnienie liczone, nie zapisane', () => {
  const originals = { ...process.env };
  let prisma: {
    household: { findUnique: jest.Mock };
    subscription: { findMany: jest.Mock };
  };
  let counters: AiUsageCountersService;

  const householdRow = (
    members: {
      userId: string;
      identityHash: string | null;
      appleSub?: string | null;
    }[],
    tierOverride: string | null = null,
  ) => ({
    tierOverride,
    memberships: members.map((member) => ({
      userId: member.userId,
      user: {
        identityHash: member.identityHash,
        appleSub: member.appleSub ?? null,
        googleId: null,
        authProvider: 'APPLE',
      },
    })),
  });

  beforeEach(() => {
    process.env.AI_TIER_OVERRIDE = 'off';
    process.env.AI_TRIAL_MESSAGES = '5';
    process.env.AI_TRIAL_PLANS = '1';
    prisma = {
      household: { findUnique: jest.fn() },
      subscription: { findMany: jest.fn().mockResolvedValue([]) },
    };
    counters = new AiUsageCountersService(prisma as unknown as PrismaService);
  });

  afterEach(() => {
    process.env = { ...originals };
  });

  it('ODPOWIEDŹ NA PYTANIE: domownik zaproszony przez płatnika MA asystenta', async () => {
    // Solo kupił PAYER. Pyta MEMBER, który nie kupił niczego.
    prisma.household.findUnique.mockResolvedValue(
      householdRow([
        { userId: PAYER, identityHash: PAYER_HASH },
        { userId: MEMBER, identityHash: MEMBER_HASH },
      ]),
    );
    prisma.subscription.findMany.mockResolvedValue([sub()]);

    const plan = await counters.resolvePlan(HOUSE, { userId: MEMBER }, NOW);
    expect(plan.tier).toBe('PRO');
    expect(plan.source).toBe('SUBSCRIPTION');
    expect(plan.product).toBe('Solo');
    // Pula jest WSPÓLNA: ten sam zakres dla płatnika i dla domownika.
    expect(plan.quotaScopeId).toBe('sub:sub-1');
    const payerPlan = await counters.resolvePlan(HOUSE, { userId: PAYER }, NOW);
    expect(payerPlan.quotaScopeId).toBe(plan.quotaScopeId);
    expect(plan.messagesLimit).toBe(30);
  });

  it('płatnik wychodzi z domu — dom traci PRO w tej samej sekundzie', async () => {
    // Nie ma czego „odpinać": uprawnienie liczy się z listy domowników.
    prisma.household.findUnique.mockResolvedValue(
      householdRow([{ userId: MEMBER, identityHash: MEMBER_HASH }]),
    );
    prisma.subscription.findMany.mockResolvedValue([]);
    const plan = await counters.resolvePlan(HOUSE, { userId: MEMBER }, NOW);
    expect(plan.tier).toBe('TRIAL');
  });

  it('przeprowadzka płatnika NIE odnawia puli — zakres idzie za umową', async () => {
    prisma.household.findUnique.mockResolvedValue(
      householdRow([{ userId: PAYER, identityHash: PAYER_HASH }]),
    );
    prisma.subscription.findMany.mockResolvedValue([sub()]);
    const inFirstHome = await counters.resolvePlan(
      HOUSE,
      { userId: PAYER },
      NOW,
    );
    const inSecondHome = await counters.resolvePlan(
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      { userId: PAYER },
      NOW,
    );
    expect(inSecondHome.quotaScopeId).toBe(inFirstHome.quotaScopeId);
  });

  it('„wyjdź z domu → załóż nowy" NIE daje świeżej puli próbnej', async () => {
    prisma.household.findUnique.mockResolvedValue(
      householdRow([{ userId: MEMBER, identityHash: MEMBER_HASH }]),
    );
    const inOldHome = await counters.resolvePlan(
      HOUSE,
      { userId: MEMBER },
      NOW,
    );
    const inNewHome = await counters.resolvePlan(
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      { userId: MEMBER },
      NOW,
    );
    expect(inOldHome.quotaScopeId).toBe(`trial:${MEMBER_HASH}`);
    expect(inNewHome.quotaScopeId).toBe(inOldHome.quotaScopeId);
    expect(inNewHome.messagesLimit).toBe(5);
    expect(inNewHome.renews).toBe(false);
  });

  it('nadanie operatora bije subskrypcję i liczy się w zakresie domu', async () => {
    prisma.household.findUnique.mockResolvedValue(
      householdRow([{ userId: PAYER, identityHash: PAYER_HASH }], 'PRO'),
    );
    const plan = await counters.resolvePlan(HOUSE, { userId: PAYER }, NOW);
    expect(plan.source).toBe('GRANTED');
    expect(plan.quotaScopeId).toBe(HOUSE);
    // Nadanie nie ma produktu — limity z env, jak dotąd.
    expect(plan.product).toBeNull();
  });

  it('PŁATNIK BEZ WYPEŁNIONEJ KOLUMNY HASZA i tak dostaje PRO', async () => {
    // `User.identityHash` wypełnia się przy logowaniu. Między zakupem a
    // najbliższym logowaniem kolumna bywa pusta — a płatnik wypadał wtedy z
    // zapytania o subskrypcje i dostawał plan PRÓBNY mimo pobranej płatności.
    // Hasz liczy się teraz na miejscu z `appleSub`, więc wynik jest ten sam,
    // co przy zapisie subskrypcji.
    const hash = purchaseIdentityHash('APPLE', 'apple-sub-platnika');
    prisma.household.findUnique.mockResolvedValue(
      householdRow([
        { userId: PAYER, identityHash: null, appleSub: 'apple-sub-platnika' },
      ]),
    );
    prisma.subscription.findMany.mockImplementation(
      ({ where }: { where: { identityHash: { in: string[] } } }) =>
        Promise.resolve(
          where.identityHash.in.includes(hash!)
            ? [sub({ identityHash: hash })]
            : [],
        ),
    );

    const plan = await counters.resolvePlan(HOUSE, { userId: PAYER }, NOW);
    expect(plan.tier).toBe('PRO');
    expect(plan.source).toBe('SUBSCRIPTION');
  });

  it('PULA PRÓBNA NIE ODNAWIA SIĘ po wypełnieniu kolumny hasza', async () => {
    // Zakres puli próbnej brał się z kolumny; pusta kolumna dawała
    // `trial:user:<id>`, a wypełniona `trial:<hasz>` — czyli następne logowanie
    // otwierało DRUGĄ darmową próbę. Teraz obie ścieżki liczą ten sam zakres.
    const hash = purchaseIdentityHash('APPLE', 'apple-sub-probny');
    prisma.household.findUnique.mockResolvedValue(
      householdRow([
        { userId: MEMBER, identityHash: null, appleSub: 'apple-sub-probny' },
      ]),
    );
    const przed = await counters.resolvePlan(HOUSE, { userId: MEMBER }, NOW);

    prisma.household.findUnique.mockResolvedValue(
      householdRow([
        { userId: MEMBER, identityHash: hash, appleSub: 'apple-sub-probny' },
      ]),
    );
    const po = await counters.resolvePlan(HOUSE, { userId: MEMBER }, NOW);

    expect(przed.tier).toBe('TRIAL');
    expect(przed.quotaScopeId).toBe(`trial:${hash!}`);
    expect(po.quotaScopeId).toBe(przed.quotaScopeId);
  });

  it('AI_TIER_OVERRIDE=PRO nie tyka bazy i daje pulę domu', async () => {
    process.env.AI_TIER_OVERRIDE = 'PRO';
    const plan = await counters.resolvePlan(HOUSE, { userId: PAYER }, NOW);
    expect(plan.source).toBe('ENV');
    expect(plan.quotaScopeId).toBe(HOUSE);
    expect(prisma.household.findUnique).not.toHaveBeenCalled();
  });

  it('migawka limitów nie pozwala obniżyć tego, co już obiecane', async () => {
    prisma.household.findUnique.mockResolvedValue(
      householdRow([{ userId: PAYER, identityHash: PAYER_HASH }]),
    );
    // Cennik mówi 30, migawka z chwili zakupu mówi 40 — wygrywa migawka.
    prisma.subscription.findMany.mockResolvedValue([
      sub({ messagesLimitSnapshot: 40, plansLimitSnapshot: 10 }),
    ]);
    const plan = await counters.resolvePlan(HOUSE, { userId: PAYER }, NOW);
    expect(plan.messagesLimit).toBe(40);
    expect(plan.plansLimit).toBe(10);
  });

  it('podwyżka limitu w cenniku działa od razu, mimo niższej migawki', async () => {
    prisma.household.findUnique.mockResolvedValue(
      householdRow([{ userId: PAYER, identityHash: PAYER_HASH }]),
    );
    prisma.subscription.findMany.mockResolvedValue([
      sub({ messagesLimitSnapshot: 10, plansLimitSnapshot: 2 }),
    ]);
    const plan = await counters.resolvePlan(HOUSE, { userId: PAYER }, NOW);
    expect(plan.messagesLimit).toBe(30);
  });

  it('dom bez domowników z haszem nie pyta o subskrypcje', async () => {
    prisma.household.findUnique.mockResolvedValue(
      householdRow([{ userId: MEMBER, identityHash: null }]),
    );
    const plan = await counters.resolvePlan(HOUSE, { userId: MEMBER }, NOW);
    expect(prisma.subscription.findMany).not.toHaveBeenCalled();
    expect(plan.quotaScopeId).toBe(`trial:user:${MEMBER}`);
  });
});
