import { Test, TestingModule } from '@nestjs/testing';
import { AgentProposalsService, cardState } from './agent-proposals.service';
import { weekBaselineHash } from './proposal-baseline';
import { PrismaService } from '../../prisma/prisma.service';
import { HouseholdsService } from '../../households/households.service';
import { WeeklyPlansService } from '../../weekly-plans/weekly-plans.service';
import { WeeklyPlansGateway } from '../../weekly-plans/weekly-plans.gateway';
import { ConsentsService } from '../../consents/consents.service';
import { AiUsageCountersService } from '../ai-usage-counters.service';
import { AgentQuotaMailService } from '../agent-quota-mail.service';
import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/app-exception';

// Zatwierdzenie propozycji to JEDYNE miejsce, w którym asystent zmienia
// tydzień. Te testy pilnują trzech obietnic złożonych użytkownikowi:
// klik nie kosztuje tokenów, drugi klik nic nie psuje, a zmiana planu spod
// ręki kończy się uczciwą odmową, nie cichym nadpisaniem.

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const householdId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const conversationId = '11111111-1111-4111-8111-111111111111';
const proposalId = '55555555-5555-4555-8555-555555555555';
const recipeId = '33333333-3333-4333-8333-333333333333';

const SLOT = { dayOfWeek: 'MON', mealType: 'LUNCH', recipeId };
const BEFORE = [
  {
    dayOfWeek: 'TUE',
    mealType: 'DINNER',
    recipeId,
    participantIds: [],
    plannedServings: 2,
  },
];

const proposalRow = (over: Record<string, unknown> = {}) => ({
  id: proposalId,
  conversationId,
  turnId: '22222222-2222-4222-8222-222222222222',
  userId,
  householdId,
  kind: 'PLAN_WEEK',
  weekStart: new Date('2026-04-13T00:00:00.000Z'),
  action: { slots: [SLOT] },
  card: { kind: 'PLAN_WEEK' },
  baselineHash: weekBaselineHash(BEFORE),
  appliedHash: null,
  status: 'PENDING',
  messageId: '99999999-9999-4999-8999-999999999999',
  undoSnapshot: null,
  appliedAt: null,
  appliedByUserId: null,
  undoneAt: null,
  expiresAt: new Date(Date.now() + 60_000),
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const makeDeps = (
  over: { proposal?: Record<string, unknown>; week?: unknown[] } = {},
) => {
  const prisma = {
    agentProposal: {
      findFirst: jest.fn().mockResolvedValue(proposalRow(over.proposal)),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
    agentMessage: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({
        id: 'msg-1',
        role: 'ASSISTANT',
        kind: 'APPLIED',
        text: 'Zapisałem plan.',
        clientMessageId: null,
        turnId: null,
        createdAt: new Date(),
        card: { kind: 'APPLIED' },
      }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    agentConversation: { update: jest.fn().mockResolvedValue({}) },
    membership: { findUnique: jest.fn().mockResolvedValue({ id: 'mem-1' }) },
  };
  const weeklyPlans = {
    snapshotWeekAsSlots: jest.fn().mockResolvedValue(over.week ?? BEFORE),
    applyWeekPlan: jest.fn().mockResolvedValue({
      applied: true,
      dryRun: false,
      violations: [],
      changes: { created: 1, updated: 0, deleted: 0 },
      plan: null,
    }),
  };
  const counters = {
    resolvePlan: jest.fn().mockResolvedValue({
      tier: 'PRO',
      source: 'ENV',
      quotaScopeId: householdId,
      periodKey: '2026-04',
      renews: true,
      resetsAt: '2026-10-01T00:00:00.000Z',
      messagesLimit: 200,
      plansLimit: 30,
    }),
    quotaDetailsFor: jest.fn().mockReturnValue(['kind:messages']),
    monthKey: jest.fn().mockReturnValue('2026-04'),
    tryConsume: jest.fn().mockResolvedValue(true),
    add: jest.fn().mockResolvedValue(undefined),
    quotaDetails: jest.fn().mockReturnValue(['kind:plans']),
  };
  const plansGateway = { broadcastWeekApplied: jest.fn() };
  const households = { memberPreferences: jest.fn().mockResolvedValue([]) };
  return { prisma, weeklyPlans, counters, plansGateway, households };
};

const buildService = async (deps: ReturnType<typeof makeDeps>) => {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      AgentProposalsService,
      { provide: PrismaService, useValue: deps.prisma },
      { provide: WeeklyPlansService, useValue: deps.weeklyPlans },
      { provide: HouseholdsService, useValue: deps.households },
      { provide: AiUsageCountersService, useValue: deps.counters },
      // Mail o wyczerpanej puli — atrapa: te testy sprawdzają propozycje,
      // nie pocztę.
      {
        provide: AgentQuotaMailService,
        useValue: { announce: jest.fn().mockResolvedValue(undefined) },
      },
      { provide: WeeklyPlansGateway, useValue: deps.plansGateway },
      // Zgoda na asystenta bramkuje talerze w propozycji „kilka talerzy"
      // (audyt 12.09.2026, P1.10). Domyślnie wszyscy w domu ją mają.
      {
        provide: ConsentsService,
        useValue: {
          usersWithValid: (ids: readonly string[]) =>
            Promise.resolve(new Set(ids)),
        },
      },
    ],
  }).compile();
  return module.get(AgentProposalsService);
};

describe('AgentProposalsService.apply', () => {
  // Tydzień PO zapisie propozycji.
  const AFTER = [
    ...BEFORE,
    { ...SLOT, participantIds: [], plannedServings: 2 },
  ];

  type Hooks = {
    guard?: (tx: unknown, current: unknown[]) => Promise<void>;
    settle?: (tx: unknown, changes: unknown) => Promise<void>;
  };

  /**
   * Atrapa domeny zachowująca się jak transakcja zapisu: `guard` → zapis
   * pozycji → `settle`, wszystko na `tx` — OSOBNYM od `prisma`, żeby test
   * widział, co poszło w transakcji, a co obok niej. `attempts` > 1 udaje
   * ponowienie po konflikcie serializacji; `failAfterPlanWrite` — awarię
   * techniczną w środku transakcji (po zapisie pozycji, przed `settle`).
   */
  const makeApplyDeps = (
    over: {
      proposal?: Record<string, unknown>;
      weekUnderLock?: unknown[];
      attempts?: number;
      changes?: { created: number; updated: number; deleted: number };
      failAfterPlanWrite?: Error;
      hiddenAt?: Date | null;
    } = {},
  ) => {
    const deps = makeDeps({ proposal: over.proposal });
    const tx = {
      agentProposal: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      agentMessage: {
        create: deps.prisma.agentMessage.create,
        findUnique: jest
          .fn()
          .mockResolvedValue({ hiddenAt: over.hiddenAt ?? null }),
      },
      agentConversation: { update: jest.fn().mockResolvedValue({}) },
    };
    const planWrite = jest.fn();
    const changes = over.changes ?? { created: 1, updated: 0, deleted: 0 };
    deps.weeklyPlans.snapshotWeekAsSlots.mockResolvedValue(AFTER);
    deps.weeklyPlans.applyWeekPlan.mockImplementation(
      async (
        _u: string,
        _h: string,
        _w: string,
        _dto: unknown,
        hooks: Hooks,
      ) => {
        for (let attempt = 0; attempt < (over.attempts ?? 1); attempt += 1) {
          await hooks.guard?.(tx, over.weekUnderLock ?? BEFORE);
          planWrite();
          if (over.failAfterPlanWrite) throw over.failAfterPlanWrite;
          await hooks.settle?.(tx, changes);
        }
        return {
          applied: true,
          dryRun: false,
          violations: [],
          changes,
          plan: null,
        };
      },
    );
    return { ...deps, tx, planWrite };
  };

  /** Poza transakcją nie może zapaść NIC, co opisuje zapis. */
  const expectNothingOutsideTransaction = (
    deps: ReturnType<typeof makeApplyDeps>,
  ) => {
    expect(deps.prisma.agentProposal.update).not.toHaveBeenCalled();
    expect(deps.prisma.agentConversation.update).not.toHaveBeenCalled();
    expect(deps.counters.add).not.toHaveBeenCalled();
    expect(deps.plansGateway.broadcastWeekApplied).not.toHaveBeenCalled();
  };

  /** Jedyne dopuszczalne dotknięcie propozycji poza transakcją: warunkowy status. */
  const markedOutside = (deps: ReturnType<typeof makeApplyDeps>) =>
    deps.prisma.agentProposal.updateMany.mock.calls.map(
      (call: [{ where: unknown; data: unknown }]) => call[0],
    );

  it('zapisuje tydzień, zdejmuje kwotę i rozgłasza zmianę', async () => {
    const deps = makeApplyDeps();
    const service = await buildService(deps);

    const result = await service.apply(userId, proposalId);

    expect(result).toMatchObject({
      proposalId,
      status: 'APPLIED',
      changes: { created: 1, updated: 0, deleted: 0 },
    });
    expect(deps.weeklyPlans.applyWeekPlan).toHaveBeenCalledWith(
      userId,
      householdId,
      '2026-04-13',
      { slots: [SLOT] },
      expect.objectContaining({
        guard: expect.any(Function),
        settle: expect.any(Function),
      }),
    );
    // Kwota planów schodzi dopiero TUTAJ — propozycja była darmowa — i na
    // KLIENCIE TRANSAKCJI: zatwierdza się razem z planem albo wcale.
    expect(deps.counters.tryConsume).toHaveBeenCalledTimes(1);
    expect(deps.counters.tryConsume).toHaveBeenCalledWith(
      deps.tx,
      householdId,
      '2026-04',
      'plans',
      30,
    );
    // Drugi telefon w domu ma się dowiedzieć o zmianie bez odświeżania.
    expect(deps.plansGateway.broadcastWeekApplied).toHaveBeenCalledTimes(1);
    expect(deps.plansGateway.broadcastWeekApplied).toHaveBeenCalledWith(
      expect.objectContaining({ householdId, weekStart: '2026-04-13' }),
    );
    // Wiadomość APPLIED ma sensowny tekst także dla klienta bez kart.
    const message = deps.prisma.agentMessage.create.mock.calls[0][0].data;
    expect(message.kind).toBe('APPLIED');
    expect(message.text).toContain('Zapisałem plan na tydzień od');
    expect(message.turnId).toBeUndefined();
    // Domknięcie propozycji w tej samej transakcji: odcisk „po" z tygodnia
    // odczytanego W transakcji, kwota do cofnięcia.
    expect(deps.weeklyPlans.snapshotWeekAsSlots).toHaveBeenCalledWith(
      userId,
      householdId,
      '2026-04-13',
      deps.tx,
    );
    expect(deps.tx.agentProposal.update).toHaveBeenCalledWith({
      where: { id: proposalId },
      data: {
        appliedHash: weekBaselineHash(AFTER),
        changedCount: 1,
        quotaPeriodKey: '2026-04',
        quotaScopeId: householdId,
      },
    });
    expect(deps.tx.agentConversation.update).toHaveBeenCalled();
    expect(deps.prisma.agentProposal.update).not.toHaveBeenCalled();
    expect(deps.prisma.agentConversation.update).not.toHaveBeenCalled();
    expect(deps.counters.add).not.toHaveBeenCalled();
    expect(markedOutside(deps)).toEqual([]);
  });

  it('przejmuje propozycję POD ZAMKIEM, przed zapisem planu, a „stan sprzed" bierze z tygodnia spod zamka', async () => {
    const deps = makeApplyDeps();
    const service = await buildService(deps);

    await service.apply(userId, proposalId);

    const claim = deps.tx.agentProposal.updateMany.mock.calls[0][0];
    expect(claim.where).toEqual({ id: proposalId, status: 'PENDING' });
    expect(claim.data).toMatchObject({
      status: 'APPLIED',
      undoSnapshot: BEFORE,
      appliedByUserId: userId,
      appliedHash: null,
    });
    expect(
      deps.tx.agentProposal.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(deps.planWrite.mock.invocationCallOrder[0]);
    // Kwota i wiadomość PO zapisie pozycji — znają już liczbę zmian.
    expect(deps.planWrite.mock.invocationCallOrder[0]).toBeLessThan(
      deps.counters.tryConsume.mock.invocationCallOrder[0],
    );
  });

  it('ponowne kliknięcie po sukcesie oddaje ten sam wynik — bez zapisu, kwoty i wiadomości', async () => {
    const deps = makeApplyDeps({
      proposal: { status: 'APPLIED', appliedAt: new Date() },
    });
    const service = await buildService(deps);

    const result = await service.apply(userId, proposalId);

    expect(result.status).toBe('APPLIED');
    expect(deps.weeklyPlans.applyWeekPlan).not.toHaveBeenCalled();
    expect(deps.counters.tryConsume).not.toHaveBeenCalled();
    expect(deps.prisma.agentMessage.create).not.toHaveBeenCalled();
  });

  it('dwa równoległe kliknięcia: przegrany odpada w `guard` — bez kwoty, bez wiadomości, z tym samym wynikiem', async () => {
    const deps = makeApplyDeps();
    // Zwycięzca już zatwierdził: przejęcie ze statusu PENDING nic nie łapie.
    deps.tx.agentProposal.updateMany.mockResolvedValue({ count: 0 });
    deps.prisma.agentProposal.findFirst
      .mockResolvedValueOnce(proposalRow())
      .mockResolvedValueOnce(
        proposalRow({ status: 'APPLIED', appliedAt: new Date() }),
      );
    const service = await buildService(deps);

    const result = await service.apply(userId, proposalId);

    expect(result.status).toBe('APPLIED');
    expect(deps.planWrite).not.toHaveBeenCalled();
    expect(deps.counters.tryConsume).not.toHaveBeenCalled();
    expect(deps.prisma.agentMessage.create).not.toHaveBeenCalled();
    expectNothingOutsideTransaction(deps);
    expect(markedOutside(deps)).toEqual([]);
  });

  it('przegrany wyścig z cofnięciem to uczciwa odmowa, nie fałszywy sukces', async () => {
    const deps = makeApplyDeps({ proposal: { status: 'UNDONE' } });
    deps.tx.agentProposal.updateMany.mockResolvedValue({ count: 0 });
    deps.prisma.agentProposal.findFirst
      .mockResolvedValueOnce(proposalRow({ status: 'UNDONE' }))
      .mockResolvedValueOnce(proposalRow({ status: 'EXPIRED' }));
    const service = await buildService(deps);

    await expect(service.apply(userId, proposalId)).rejects.toMatchObject({
      status: 409,
      response: { code: 'AI_PROPOSAL_STALE', details: ['reason:EXPIRED'] },
    });
    expect(deps.counters.tryConsume).not.toHaveBeenCalled();
    expect(deps.prisma.agentMessage.create).not.toHaveBeenCalled();
  });

  it('ponowiona próba transakcji sprawdza warunki od nowa, a rozgłoszenie idzie raz, po zatwierdzeniu', async () => {
    const deps = makeApplyDeps({ attempts: 2 });
    const service = await buildService(deps);

    await service.apply(userId, proposalId);

    expect(deps.tx.agentProposal.updateMany).toHaveBeenCalledTimes(2);
    expect(deps.plansGateway.broadcastWeekApplied).toHaveBeenCalledTimes(1);
  });

  it('plan zmieniony spod ręki = odmowa, nie ciche nadpisanie — odcisk liczy się z tygodnia POD ZAMKIEM', async () => {
    // Tydzień jest już inny niż przy propozycji — widać to dopiero w `guard`.
    const deps = makeApplyDeps({ weekUnderLock: [] });
    const service = await buildService(deps);

    await expect(service.apply(userId, proposalId)).rejects.toMatchObject({
      status: 409,
      response: { code: 'AI_PROPOSAL_STALE', details: ['reason:CHANGED'] },
    });
    expect(deps.planWrite).not.toHaveBeenCalled();
    expect(deps.counters.tryConsume).not.toHaveBeenCalled();
    expect(deps.prisma.agentMessage.create).not.toHaveBeenCalled();
    expectNothingOutsideTransaction(deps);
    // STALE warunkowo, ze statusu, który widzieliśmy.
    expect(markedOutside(deps)).toEqual([
      {
        where: { id: proposalId, status: 'PENDING' },
        data: { status: 'STALE' },
      },
    ]);
  });

  it('„Zapisz mimo to" (`force`) pomija wyłącznie odcisk planu', async () => {
    const deps = makeApplyDeps({
      proposal: { status: 'STALE' },
      weekUnderLock: [],
    });
    const service = await buildService(deps);

    const result = await service.apply(userId, proposalId, { force: true });

    expect(result.status).toBe('APPLIED');
    expect(deps.tx.agentProposal.updateMany.mock.calls[0][0].where).toEqual({
      id: proposalId,
      status: 'STALE',
    });
  });

  it('STALE bez `force` to odmowa, nawet gdy plan wrócił do stanu z propozycji', async () => {
    const deps = makeApplyDeps({ proposal: { status: 'STALE' } });
    const service = await buildService(deps);

    await expect(service.apply(userId, proposalId)).rejects.toMatchObject({
      status: 409,
      response: { code: 'AI_PROPOSAL_STALE', details: ['reason:STALE'] },
    });
    expect(deps.weeklyPlans.applyWeekPlan).not.toHaveBeenCalled();
    expect(deps.counters.tryConsume).not.toHaveBeenCalled();
  });

  it('pytanie poprawione po propozycji: odmowa także z `force` — bez planu, kwoty i wiadomości', async () => {
    const deps = makeApplyDeps({
      proposal: { status: 'STALE' },
      hiddenAt: new Date(),
    });
    const service = await buildService(deps);

    await expect(
      service.apply(userId, proposalId, { force: true }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'AI_PROPOSAL_STALE', details: ['reason:WITHDRAWN'] },
    });
    expect(deps.planWrite).not.toHaveBeenCalled();
    expect(deps.counters.tryConsume).not.toHaveBeenCalled();
    expect(deps.prisma.agentMessage.create).not.toHaveBeenCalled();
    expectNothingOutsideTransaction(deps);
  });

  it('propozycja po terminie nie da się zatwierdzić', async () => {
    const deps = makeApplyDeps({
      proposal: { expiresAt: new Date(Date.now() - 1000) },
    });
    const service = await buildService(deps);

    await expect(service.apply(userId, proposalId)).rejects.toMatchObject({
      status: 409,
      response: { code: 'AI_PROPOSAL_EXPIRED' },
    });
    expect(deps.weeklyPlans.applyWeekPlan).not.toHaveBeenCalled();
    expect(markedOutside(deps)).toEqual([
      {
        where: { id: proposalId, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      },
    ]);
  });

  it('wyczerpana kwota planów wycofuje całość i zostawia propozycję do kliknięcia później', async () => {
    const deps = makeApplyDeps();
    deps.counters.tryConsume.mockResolvedValue(false);
    const service = await buildService(deps);

    await expect(service.apply(userId, proposalId)).rejects.toMatchObject({
      status: 429,
      response: { code: 'AI_PLAN_QUOTA_EXCEEDED' },
    });
    // Rzut z `settle` wycofuje przejęcie i zapis pozycji; poza transakcją
    // status zostaje nietknięty (PENDING), nie ma wiadomości ani zwrotu.
    expect(deps.prisma.agentMessage.create).not.toHaveBeenCalled();
    expectNothingOutsideTransaction(deps);
    expect(markedOutside(deps)).toEqual([]);
  });

  it('zapis bez zmian nie dotyka kwoty i nie obiecuje „Cofnij"', async () => {
    const deps = makeApplyDeps({
      changes: { created: 0, updated: 0, deleted: 0 },
    });
    const service = await buildService(deps);

    await service.apply(userId, proposalId);

    expect(deps.counters.tryConsume).not.toHaveBeenCalled();
    expect(deps.tx.agentProposal.update.mock.calls[0][0].data).toMatchObject({
      changedCount: 0,
      quotaPeriodKey: null,
      quotaScopeId: null,
    });
  });

  it('wyrzucenie z domu przed zatwierdzeniem: odmowa domeny przechodzi dalej, status nietknięty, kwota nie schodzi', async () => {
    const deps = makeApplyDeps({
      failAfterPlanWrite: new AppException(
        'NOT_HOUSEHOLD_MEMBER',
        'User is not a member of this household',
        HttpStatus.FORBIDDEN,
      ),
    });
    const service = await buildService(deps);

    await expect(service.apply(userId, proposalId)).rejects.toMatchObject({
      status: 403,
      response: { code: 'NOT_HOUSEHOLD_MEMBER' },
    });
    expect(deps.counters.tryConsume).not.toHaveBeenCalled();
    expect(deps.prisma.agentMessage.create).not.toHaveBeenCalled();
    expectNothingOutsideTransaction(deps);
    // Odmowa, nie awaria: żadnego FAILED ani STALE — zostaje PENDING.
    expect(markedOutside(deps)).toEqual([]);
  });

  it('awaria techniczna w transakcji: błąd idzie dalej, propozycja FAILED (warunkowo), bez wiadomości i kwoty', async () => {
    const deps = makeApplyDeps({ failAfterPlanWrite: new Error('baza padła') });
    const service = await buildService(deps);

    await expect(service.apply(userId, proposalId)).rejects.toThrow(
      'baza padła',
    );
    expect(deps.counters.tryConsume).not.toHaveBeenCalled();
    expect(deps.prisma.agentMessage.create).not.toHaveBeenCalled();
    expectNothingOutsideTransaction(deps);
    expect(markedOutside(deps)).toEqual([
      {
        where: { id: proposalId, status: 'PENDING' },
        data: { status: 'FAILED' },
      },
    ]);
  });

  it('błąd licznika kwoty NIE jest połykany — wywraca zapis, zamiast zostawić plan bez rozliczenia', async () => {
    const deps = makeApplyDeps();
    deps.counters.tryConsume.mockRejectedValue(new Error('licznik padł'));
    const service = await buildService(deps);

    await expect(service.apply(userId, proposalId)).rejects.toThrow(
      'licznik padł',
    );
    expect(deps.prisma.agentMessage.create).not.toHaveBeenCalled();
    expectNothingOutsideTransaction(deps);
  });

  it('błąd zapisu wiadomości po zapisie planu wycofuje CAŁOŚĆ — nie ma planu bez potwierdzenia ani FAILED przy zmienionym planie', async () => {
    const deps = makeApplyDeps();
    deps.prisma.agentMessage.create.mockRejectedValue(
      new Error('wiadomość padła'),
    );
    const service = await buildService(deps);

    await expect(service.apply(userId, proposalId)).rejects.toThrow(
      'wiadomość padła',
    );
    // Wszystko to biegło w `tx` i jest wycofane razem z planem.
    expect(deps.tx.agentProposal.update).not.toHaveBeenCalled();
    expectNothingOutsideTransaction(deps);
  });

  it('błąd ustawienia FAILED nie zasłania pierwotnego błędu', async () => {
    const deps = makeApplyDeps({ failAfterPlanWrite: new Error('baza padła') });
    deps.prisma.agentProposal.updateMany.mockRejectedValue(
      new Error('status padł'),
    );
    const service = await buildService(deps);

    await expect(service.apply(userId, proposalId)).rejects.toThrow(
      'baza padła',
    );
  });

  it('cudza propozycja wygląda tak samo jak nieistniejąca', async () => {
    const deps = makeApplyDeps();
    deps.prisma.agentProposal.findFirst.mockResolvedValue(null);
    const service = await buildService(deps);

    await expect(service.apply(userId, proposalId)).rejects.toMatchObject({
      status: 404,
      response: { code: 'AI_PROPOSAL_NOT_FOUND' },
    });
  });

  it('naruszenia przy zapisie zamykają propozycję jako STALE — kwota nie schodzi', async () => {
    const deps = makeApplyDeps();
    deps.weeklyPlans.applyWeekPlan.mockResolvedValue({
      applied: false,
      dryRun: false,
      violations: [{ code: 'RECIPE_ALLERGEN_CONFLICT' }],
      changes: { created: 0, updated: 0, deleted: 0 },
      plan: null,
    });
    const service = await buildService(deps);

    await expect(service.apply(userId, proposalId)).rejects.toMatchObject({
      status: 409,
      response: {
        code: 'AI_PROPOSAL_STALE',
        details: ['reason:VIOLATIONS', 'RECIPE_ALLERGEN_CONFLICT'],
      },
    });
    expect(deps.counters.tryConsume).not.toHaveBeenCalled();
    expect(markedOutside(deps)).toEqual([
      {
        where: { id: proposalId, status: 'PENDING' },
        data: { status: 'STALE' },
      },
    ]);
  });
});

describe('AgentProposalsService.undo', () => {
  // Tydzień PO zapisie propozycji — różny od `BEFORE`.
  const AFTER = [
    ...BEFORE,
    { ...SLOT, participantIds: [], plannedServings: 2 },
  ];
  const appliedAt = new Date();
  const applied = {
    status: 'APPLIED',
    appliedAt,
    undoSnapshot: BEFORE,
    quotaPeriodKey: '2026-04',
    quotaScopeId: householdId,
    changedCount: 1,
    appliedHash: weekBaselineHash(AFTER),
  };

  type Hooks = {
    guard?: (tx: unknown, current: unknown[]) => Promise<void>;
    settle?: (tx: unknown, changes: unknown) => Promise<void>;
  };

  /**
   * Atrapa domeny, która zachowuje się jak prawdziwa transakcja zapisu:
   * `guard` → zapis pozycji → `settle`, wszystko na `tx` — OSOBNYM od
   * `prisma`, żeby test widział, co poszło w transakcji, a co obok niej.
   * `attempts` > 1 udaje ponowienie po konflikcie serializacji.
   */
  const makeUndoDeps = (
    over: {
      proposal?: Record<string, unknown>;
      weekUnderLock?: unknown[];
      attempts?: number;
    } = {},
  ) => {
    const deps = makeDeps({ proposal: { ...applied, ...over.proposal } });
    const tx = {
      agentProposal: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      agentMessage: { create: deps.prisma.agentMessage.create },
      agentConversation: { update: jest.fn().mockResolvedValue({}) },
    };
    const planWrite = jest.fn();
    const changes = { created: 0, updated: 0, deleted: 1 };
    deps.weeklyPlans.applyWeekPlan.mockImplementation(
      async (
        _u: string,
        _h: string,
        _w: string,
        _dto: unknown,
        hooks: Hooks,
      ) => {
        for (let attempt = 0; attempt < (over.attempts ?? 1); attempt += 1) {
          await hooks.guard?.(tx, over.weekUnderLock ?? AFTER);
          planWrite();
          await hooks.settle?.(tx, changes);
        }
        return {
          applied: true,
          dryRun: false,
          violations: [],
          changes,
          plan: null,
        };
      },
    );
    return { ...deps, tx, planWrite };
  };

  const expectNothingOutsideTransaction = (
    deps: ReturnType<typeof makeUndoDeps>,
  ) => {
    expect(deps.prisma.agentProposal.updateMany).not.toHaveBeenCalled();
    expect(deps.prisma.agentProposal.update).not.toHaveBeenCalled();
    expect(deps.plansGateway.broadcastWeekApplied).not.toHaveBeenCalled();
  };

  it('przywraca tydzień sprzed zapisu i zwraca kwotę', async () => {
    const deps = makeUndoDeps();
    const service = await buildService(deps);

    const result = await service.undo(userId, proposalId);

    expect(result.status).toBe('UNDONE');
    // Stan docelowy jest swoją własną odwrotnością — cofnięcie to ten sam
    // zapis, tylko poprzednią treścią.
    expect(deps.weeklyPlans.applyWeekPlan).toHaveBeenCalledWith(
      userId,
      householdId,
      '2026-04-13',
      { slots: BEFORE },
      expect.objectContaining({
        guard: expect.any(Function),
        settle: expect.any(Function),
      }),
    );
    expect(deps.counters.add).toHaveBeenCalledTimes(1);
    expect(deps.prisma.agentMessage.create.mock.calls[0][0].data.kind).toBe(
      'TEXT',
    );
    expect(deps.plansGateway.broadcastWeekApplied).toHaveBeenCalledTimes(1);
  });

  it('przejęcie propozycji, zwrot kwoty i wiadomość idą W TRANSAKCJI zapisu planu, przejęcie PRZED zapisem', async () => {
    const deps = makeUndoDeps();
    const service = await buildService(deps);

    await service.undo(userId, proposalId);

    // `appliedAt` w warunku: cofnięcie spóźnione o cykl „cofnij → zapisz
    // ponownie" nie może przejąć NOWEGO zapisu.
    expect(deps.tx.agentProposal.updateMany).toHaveBeenCalledWith({
      where: { id: proposalId, status: 'APPLIED', appliedAt },
      data: expect.objectContaining({
        status: 'UNDONE',
        quotaPeriodKey: null,
        quotaScopeId: null,
      }),
    });
    expect(
      deps.tx.agentProposal.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(deps.planWrite.mock.invocationCallOrder[0]);
    // Licznik dostaje KLIENTA TRANSAKCJI, nie `prisma` — zwrot zatwierdza
    // się razem ze statusem albo wcale.
    expect(deps.counters.add).toHaveBeenCalledWith(
      deps.tx,
      householdId,
      '2026-04',
      'plans',
      -1,
    );
    expect(deps.tx.agentConversation.update).toHaveBeenCalled();
    expect(deps.prisma.agentConversation.update).not.toHaveBeenCalled();
    expect(deps.prisma.agentProposal.updateMany).not.toHaveBeenCalled();
    expect(deps.prisma.agentProposal.update).not.toHaveBeenCalled();
  });

  it('spóźnione cofnięcie odpada PRZED zapisem planu; gdy propozycja jest już cofnięta — ten sam wynik', async () => {
    const deps = makeUndoDeps();
    deps.tx.agentProposal.updateMany.mockResolvedValue({ count: 0 });
    deps.prisma.agentProposal.findFirst
      .mockResolvedValueOnce(proposalRow(applied))
      .mockResolvedValueOnce(proposalRow({ ...applied, status: 'UNDONE' }));
    const service = await buildService(deps);

    const result = await service.undo(userId, proposalId);

    expect(result.status).toBe('UNDONE');
    expect(deps.planWrite).not.toHaveBeenCalled();
    expect(deps.counters.add).not.toHaveBeenCalled();
    expect(deps.prisma.agentMessage.create).not.toHaveBeenCalled();
    expectNothingOutsideTransaction(deps);
  });

  it('cofnięcie spóźnione o cykl „cofnij → zapisz ponownie" to odmowa bez dotknięcia planu', async () => {
    const deps = makeUndoDeps();
    deps.tx.agentProposal.updateMany.mockResolvedValue({ count: 0 });
    deps.prisma.agentProposal.findFirst
      .mockResolvedValueOnce(proposalRow(applied))
      .mockResolvedValueOnce(
        proposalRow({ ...applied, appliedAt: new Date(Date.now() + 1000) }),
      );
    const service = await buildService(deps);

    await expect(service.undo(userId, proposalId)).rejects.toMatchObject({
      status: 409,
      response: { code: 'AI_PROPOSAL_STALE', details: ['reason:APPLIED'] },
    });
    expect(deps.planWrite).not.toHaveBeenCalled();
    expect(deps.counters.add).not.toHaveBeenCalled();
    expect(deps.prisma.agentMessage.create).not.toHaveBeenCalled();
    expectNothingOutsideTransaction(deps);
  });

  it('nie kasuje zmian, które ktoś zrobił PO zapisie — odcisk liczy się z tygodnia odczytanego POD ZAMKIEM', async () => {
    // `snapshotWeekAsSlots` (odczyt poza transakcją) mówi „bez zmian";
    // prawdę zna dopiero `current` przekazane do `guard`.
    const deps = makeUndoDeps({
      weekUnderLock: [...AFTER, { ...SLOT, dayOfWeek: 'WED' }],
    });
    const service = await buildService(deps);

    await expect(service.undo(userId, proposalId)).rejects.toMatchObject({
      status: 409,
      response: {
        code: 'AI_PROPOSAL_STALE',
        details: ['reason:CHANGED_AFTER_APPLY'],
      },
    });
    expect(deps.planWrite).not.toHaveBeenCalled();
    expect(deps.counters.add).not.toHaveBeenCalled();
    expect(deps.prisma.agentMessage.create).not.toHaveBeenCalled();
    expectNothingOutsideTransaction(deps);
  });

  it('odmowa przywrócenia planu (np. alergen dodany po zapisie) NIE jest cofnięciem', async () => {
    const deps = makeUndoDeps();
    deps.weeklyPlans.applyWeekPlan.mockResolvedValue({
      applied: false,
      dryRun: false,
      violations: [
        { index: 0, code: 'RECIPE_ALLERGEN_CONFLICT', message: 'alergen' },
      ],
      changes: { created: 0, updated: 0, deleted: 0 },
      plan: null,
    });
    const service = await buildService(deps);

    await expect(service.undo(userId, proposalId)).rejects.toMatchObject({
      status: 409,
      response: {
        code: 'AI_PROPOSAL_STALE',
        details: ['reason:VIOLATIONS', 'RECIPE_ALLERGEN_CONFLICT'],
      },
    });
    expect(deps.tx.agentProposal.updateMany).not.toHaveBeenCalled();
    expect(deps.counters.add).not.toHaveBeenCalled();
    expect(deps.prisma.agentMessage.create).not.toHaveBeenCalled();
    expectNothingOutsideTransaction(deps);
  });

  it('błąd zwrotu kwoty NIE jest połykany — wywraca transakcję, zamiast zgubić zwrot', async () => {
    const deps = makeUndoDeps();
    deps.counters.add.mockRejectedValue(new Error('licznik padł'));
    const service = await buildService(deps);

    await expect(service.undo(userId, proposalId)).rejects.toThrow(
      'licznik padł',
    );
    expect(deps.prisma.agentMessage.create).not.toHaveBeenCalled();
    expectNothingOutsideTransaction(deps);
  });

  it('wyjątek z zapisu planu przechodzi dalej i nic nie dzieje się poza transakcją', async () => {
    const deps = makeUndoDeps();
    deps.weeklyPlans.applyWeekPlan.mockRejectedValue(new Error('baza padła'));
    const service = await buildService(deps);

    await expect(service.undo(userId, proposalId)).rejects.toThrow(
      'baza padła',
    );
    expect(deps.counters.add).not.toHaveBeenCalled();
    expectNothingOutsideTransaction(deps);
  });

  it('ponowiona próba transakcji sprawdza warunki od nowa, a rozgłoszenie idzie raz, po zatwierdzeniu', async () => {
    const deps = makeUndoDeps({ attempts: 2 });
    const service = await buildService(deps);

    await service.undo(userId, proposalId);

    expect(deps.tx.agentProposal.updateMany).toHaveBeenCalledTimes(2);
    expect(deps.plansGateway.broadcastWeekApplied).toHaveBeenCalledTimes(1);
  });

  it('zapis bez zdjętej kwoty nie ma czego zwracać', async () => {
    const deps = makeUndoDeps({
      proposal: { quotaPeriodKey: null, quotaScopeId: null },
    });
    const service = await buildService(deps);

    await service.undo(userId, proposalId);

    expect(deps.counters.add).not.toHaveBeenCalled();
  });

  it('po oknie czasowym cofnąć się nie da', async () => {
    const deps = makeUndoDeps({
      proposal: { appliedAt: new Date(Date.now() - 10 * 60 * 60 * 1000) },
    });
    const service = await buildService(deps);

    await expect(service.undo(userId, proposalId)).rejects.toMatchObject({
      status: 409,
      response: { code: 'AI_PROPOSAL_EXPIRED' },
    });
    expect(deps.weeklyPlans.applyWeekPlan).not.toHaveBeenCalled();
  });

  it('zapis bez migawki „przed" nie jest cofany — pusty stan docelowy wyczyściłby tydzień', async () => {
    const deps = makeUndoDeps({ proposal: { undoSnapshot: null } });
    const service = await buildService(deps);

    await expect(service.undo(userId, proposalId)).rejects.toMatchObject({
      status: 409,
      response: {
        code: 'AI_PROPOSAL_STALE',
        details: ['reason:NOT_FINALISED'],
      },
    });
    expect(deps.weeklyPlans.applyWeekPlan).not.toHaveBeenCalled();
    expect(deps.counters.add).not.toHaveBeenCalled();
  });

  it('nie ma czego cofać, gdy nic nie zapisano', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    await expect(service.undo(userId, proposalId)).rejects.toMatchObject({
      status: 409,
      response: { code: 'AI_PROPOSAL_STALE' },
    });
  });
});

describe('cardState', () => {
  const hour = 60 * 60 * 1000;
  const now = Date.now();

  it('czekająca propozycja da się zatwierdzić do terminu', () => {
    expect(
      cardState(
        { status: 'PENDING', expiresAt: new Date(now + hour), appliedAt: null },
        now,
        hour,
      ),
    ).toMatchObject({ status: 'PENDING', canApply: true, canUndo: false });
  });

  it('po terminie przycisk gaśnie sam, bez żadnego crona', () => {
    expect(
      cardState(
        { status: 'PENDING', expiresAt: new Date(now - 1), appliedAt: null },
        now,
        hour,
      ),
    ).toMatchObject({ status: 'EXPIRED', canApply: false });
  });

  it('zapisana propozycja daje cofnięcie tylko w oknie czasowym', () => {
    const fresh = cardState(
      {
        status: 'APPLIED',
        expiresAt: new Date(now),
        appliedAt: new Date(now - 60_000),
      },
      now,
      hour,
    );
    expect(fresh).toMatchObject({
      status: 'APPLIED',
      canApply: false,
      canUndo: true,
    });

    const old = cardState(
      {
        status: 'APPLIED',
        expiresAt: new Date(now),
        appliedAt: new Date(now - 2 * hour),
      },
      now,
      hour,
    );
    expect(old.canUndo).toBe(false);
  });

  it('cofnięta, nieaktualna i nieudana propozycja po 72 h mówią EXPIRED bez przycisku', () => {
    for (const status of ['UNDONE', 'STALE', 'FAILED']) {
      expect(
        cardState(
          { status, expiresAt: new Date(now), appliedAt: null },
          now,
          hour,
        ),
      ).toMatchObject({ status: 'EXPIRED', canApply: false, canUndo: false });
    }
  });

  it('przed wygaśnięciem cofnięta i nieudana mają „Zapisz ponownie", a nieaktualna „Zapisz mimo to"', () => {
    for (const status of ['UNDONE', 'STALE', 'FAILED']) {
      expect(
        cardState(
          { status, expiresAt: new Date(now + hour), appliedAt: null },
          now,
          hour,
        ),
      ).toMatchObject({ status, canApply: true, canUndo: false });
    }
  });

  it('zapis bez zmian nie obiecuje „Cofnij"', () => {
    expect(
      cardState(
        {
          status: 'APPLIED',
          expiresAt: new Date(now + hour),
          appliedAt: new Date(now),
          changedCount: 0,
        },
        now,
        hour,
      ),
    ).toMatchObject({ status: 'APPLIED', canUndo: false });
  });
});
