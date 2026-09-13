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
  it('zapisuje tydzień, zdejmuje kwotę i rozgłasza zmianę', async () => {
    const deps = makeDeps();
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
    );
    // Kwota planów schodzi dopiero TUTAJ — propozycja była darmowa.
    expect(deps.counters.tryConsume).toHaveBeenCalledWith(
      deps.prisma,
      householdId,
      '2026-04',
      'plans',
      expect.any(Number),
    );
    // Drugi telefon w domu ma się dowiedzieć o zmianie bez odświeżania.
    expect(deps.plansGateway.broadcastWeekApplied).toHaveBeenCalledWith(
      expect.objectContaining({ householdId, weekStart: '2026-04-13' }),
    );
    // Wiadomość APPLIED ma sensowny tekst także dla klienta bez kart.
    const message = deps.prisma.agentMessage.create.mock.calls[0][0].data;
    expect(message.kind).toBe('APPLIED');
    expect(message.text).toContain('Zapisałem plan na tydzień od');
    expect(message.turnId).toBeUndefined();
  });

  it('zapisuje stan SPRZED zmiany jako materiał na „Cofnij”', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    await service.apply(userId, proposalId);

    const lock = deps.prisma.agentProposal.updateMany.mock.calls[0][0];
    expect(lock.where).toEqual({ id: proposalId, status: 'PENDING' });
    expect(lock.data.undoSnapshot).toEqual(BEFORE);
  });

  it('drugie kliknięcie oddaje ten sam wynik, nie drugi zapis', async () => {
    const deps = makeDeps({
      proposal: { status: 'APPLIED', appliedAt: new Date() },
    });
    const service = await buildService(deps);

    const result = await service.apply(userId, proposalId);

    expect(result.status).toBe('APPLIED');
    expect(deps.weeklyPlans.applyWeekPlan).not.toHaveBeenCalled();
    expect(deps.counters.tryConsume).not.toHaveBeenCalled();
  });

  it('plan zmieniony spod ręki = odmowa, nie ciche nadpisanie', async () => {
    const deps = makeDeps({ week: [] }); // tydzień jest już inny niż przy propozycji
    const service = await buildService(deps);

    await expect(service.apply(userId, proposalId)).rejects.toMatchObject({
      status: 409,
      response: { code: 'AI_PROPOSAL_STALE' },
    });
    expect(deps.weeklyPlans.applyWeekPlan).not.toHaveBeenCalled();
    expect(deps.prisma.agentProposal.update).toHaveBeenCalledWith({
      where: { id: proposalId },
      data: { status: 'STALE' },
    });
  });

  it('propozycja po terminie nie da się zatwierdzić', async () => {
    const deps = makeDeps({
      proposal: { expiresAt: new Date(Date.now() - 1000) },
    });
    const service = await buildService(deps);

    await expect(service.apply(userId, proposalId)).rejects.toMatchObject({
      status: 409,
      response: { code: 'AI_PROPOSAL_EXPIRED' },
    });
    expect(deps.weeklyPlans.applyWeekPlan).not.toHaveBeenCalled();
  });

  it('wyczerpana kwota planów zostawia propozycję do kliknięcia później', async () => {
    const deps = makeDeps();
    deps.counters.tryConsume.mockResolvedValue(false);
    const service = await buildService(deps);

    await expect(service.apply(userId, proposalId)).rejects.toMatchObject({
      status: 429,
      response: { code: 'AI_PLAN_QUOTA_EXCEEDED' },
    });
    expect(deps.weeklyPlans.applyWeekPlan).not.toHaveBeenCalled();
    // Kwota schodzi PRZED zamkiem — odmowa nie dotyka propozycji wcale.
    expect(deps.prisma.agentProposal.updateMany).not.toHaveBeenCalled();
    expect(deps.prisma.agentProposal.update).not.toHaveBeenCalled();
  });

  it('przegrany wyścig o zamek oddaje kwotę, bo zwycięzca już ją zjadł', async () => {
    const deps = makeDeps();
    deps.prisma.agentProposal.updateMany.mockResolvedValue({ count: 0 });
    const service = await buildService(deps);

    await service.apply(userId, proposalId);

    expect(deps.weeklyPlans.applyWeekPlan).not.toHaveBeenCalled();
    expect(deps.counters.add).toHaveBeenCalledWith(
      deps.prisma,
      householdId,
      '2026-04',
      'plans',
      -1,
    );
  });

  it('cudza propozycja wygląda tak samo jak nieistniejąca', async () => {
    const deps = makeDeps();
    deps.prisma.agentProposal.findFirst.mockResolvedValue(null);
    const service = await buildService(deps);

    await expect(service.apply(userId, proposalId)).rejects.toMatchObject({
      status: 404,
      response: { code: 'AI_PROPOSAL_NOT_FOUND' },
    });
  });

  it('naruszenia przy zapisie zwracają kwotę i zamykają propozycję', async () => {
    const deps = makeDeps();
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
      response: { code: 'AI_PROPOSAL_STALE' },
    });
    expect(deps.counters.add).toHaveBeenCalledWith(
      deps.prisma,
      householdId,
      '2026-04',
      'plans',
      -1,
    );
  });
});

describe('AgentProposalsService.undo', () => {
  const applied = {
    status: 'APPLIED',
    appliedAt: new Date(),
    undoSnapshot: BEFORE,
    quotaPeriodKey: '2026-04',
    changedCount: 2,
    appliedHash: weekBaselineHash(BEFORE),
  };

  it('przywraca tydzień sprzed zapisu i zwraca kwotę', async () => {
    const deps = makeDeps({ proposal: applied });
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
    );
    expect(deps.counters.add).toHaveBeenCalledWith(
      deps.prisma,
      householdId,
      '2026-04',
      'plans',
      -1,
    );
    expect(deps.prisma.agentMessage.create.mock.calls[0][0].data.kind).toBe(
      'TEXT',
    );
  });

  it('nie kasuje zmian, które ktoś zrobił PO zapisie', async () => {
    const deps = makeDeps({
      proposal: { ...applied, appliedHash: 'inny-odcisk' },
    });
    const service = await buildService(deps);

    await expect(service.undo(userId, proposalId)).rejects.toMatchObject({
      status: 409,
      response: { code: 'AI_PROPOSAL_STALE' },
    });
    expect(deps.weeklyPlans.applyWeekPlan).not.toHaveBeenCalled();
  });

  it('po oknie czasowym cofnąć się nie da', async () => {
    const deps = makeDeps({
      proposal: {
        ...applied,
        appliedAt: new Date(Date.now() - 10 * 60 * 60 * 1000),
      },
    });
    const service = await buildService(deps);

    await expect(service.undo(userId, proposalId)).rejects.toMatchObject({
      status: 409,
      response: { code: 'AI_PROPOSAL_EXPIRED' },
    });
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
