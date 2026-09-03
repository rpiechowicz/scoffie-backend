import { Test, TestingModule } from '@nestjs/testing';
import { AgentProposalsService } from './agent-proposals.service';
import { PrismaService } from '../../prisma/prisma.service';
import { HouseholdsService } from '../../households/households.service';
import { WeeklyPlansService } from '../../weekly-plans/weekly-plans.service';
import { WeeklyPlansGateway } from '../../weekly-plans/weekly-plans.gateway';
import { AiUsageCountersService } from '../ai-usage-counters.service';

// Sedno modelu „agent proponuje, człowiek zatwierdza": tura NIC nie zapisuje
// w planie. Te testy pilnują, że propozycja z naruszeniem nie powstaje wcale,
// a ta czysta zostaje w bazie razem ze stanem docelowym, którego klient
// nigdy nie zobaczy.

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const householdId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const conversationId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';
const recipeId = '33333333-3333-4333-8333-333333333333';
const weekStart = '2026-04-13';

const cleanPreview = {
  violations: [],
  changes: { created: 1, updated: 0, deleted: 0 },
  slots: [
    {
      dayOfWeek: 'MON',
      mealType: 'LUNCH',
      recipeId,
      title: 'Kurczak z ryżem',
      kcalPerServing: 600,
      prepTimeMinutes: 30,
      participantIds: [],
      change: 'NEW',
    },
  ],
  removed: [],
};

const makeDeps = (over: { preview?: unknown; members?: unknown } = {}) => {
  const prisma = { agentProposal: { create: jest.fn().mockResolvedValue({}) } };
  const weeklyPlans = {
    previewWeekPlan: jest.fn().mockResolvedValue(over.preview ?? cleanPreview),
    snapshotWeekAsSlots: jest.fn().mockResolvedValue([]),
  };
  const households = {
    memberPreferences: jest
      .fn()
      .mockResolvedValue(
        over.members ?? [{ userId, targets: { calorieGoal: 2100 } }],
      ),
  };
  const counters = {
    resolvePlan: jest.fn().mockResolvedValue({
      tier: 'PRO',
      source: 'ENV',
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
  };
  const plansGateway = { broadcastWeekApplied: jest.fn() };
  return { prisma, weeklyPlans, households, counters, plansGateway };
};

const buildService = async (deps: ReturnType<typeof makeDeps>) => {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      AgentProposalsService,
      { provide: PrismaService, useValue: deps.prisma },
      { provide: WeeklyPlansService, useValue: deps.weeklyPlans },
      { provide: HouseholdsService, useValue: deps.households },
      { provide: AiUsageCountersService, useValue: deps.counters },
      { provide: WeeklyPlansGateway, useValue: deps.plansGateway },
    ],
  }).compile();
  return module.get(AgentProposalsService);
};

const input = {
  userId,
  householdId,
  conversationId,
  turnId,
  weekStart,
  slots: [{ dayOfWeek: 'MON', mealType: 'LUNCH', recipeId }] as never,
};

describe('AgentProposalsService.createWeekPlanProposal', () => {
  it('przy naruszeniu NIE powstaje żadna propozycja', async () => {
    const deps = makeDeps({
      preview: {
        violations: [
          {
            index: 0,
            dayOfWeek: 'MON',
            mealType: 'LUNCH',
            recipeId,
            code: 'RECIPE_ALLERGEN_CONFLICT',
            message: 'Alergen domownika',
          },
        ],
        changes: { created: 0, updated: 0, deleted: 0 },
        slots: null,
        removed: null,
      },
    });
    const service = await buildService(deps);

    const result = await service.createWeekPlanProposal(input);

    expect(result).toMatchObject({ proposed: false });
    expect(deps.prisma.agentProposal.create).not.toHaveBeenCalled();
  });

  it('zapisuje propozycję ze stanem docelowym i kartą, oddając modelowi minimum', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    const result = await service.createWeekPlanProposal({
      ...input,
      note: 'Nic się nie powtarza.',
    });

    expect(result).toMatchObject({
      proposed: true,
      summary: {
        meals: 1,
        created: 1,
        averageKcalPerDay: 600,
        targetKcalPerDay: 2100,
      },
    });
    // Model nie dostaje całej karty — inaczej przepisałby ją w odpowiedzi
    // i użytkownik zapłaciłby za te same liczby drugi raz.
    expect(result).not.toHaveProperty('card');

    const data = deps.prisma.agentProposal.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      conversationId,
      turnId,
      householdId,
      kind: 'PLAN_WEEK',
    });
    // Status zostawiamy bazie — domyślne PENDING jest w schemacie.
    expect(data.status).toBeUndefined();
    expect(data.action).toEqual({ slots: input.slots });
    expect(data.card).toMatchObject({ kind: 'PLAN_WEEK', proposalId: data.id });
    expect(typeof data.baselineHash).toBe('string');
    expect(data.expiresAt.getTime()).toBeGreaterThan(Date.now());
    // Propozycja nie jest jeszcze przypięta do wiadomości — zrobi to runner
    // przy domykaniu tury. Do tego czasu jest nieosiągalna i to jest celowe.
    expect(data.messageId).toBeUndefined();
  });

  it('brak celu kalorycznego nie wywraca propozycji', async () => {
    const deps = makeDeps();
    deps.households.memberPreferences.mockRejectedValue(new Error('offline'));
    const service = await buildService(deps);

    const result = await service.createWeekPlanProposal(input);

    expect(result).toMatchObject({ proposed: true });
    const data = deps.prisma.agentProposal.create.mock.calls[0][0].data;
    expect(data.card.summary.targetKcalPerDay).toBeNull();
  });

  it('liczy tydzień tą samą ścieżką co zapis — z walidacją domeny', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    await service.createWeekPlanProposal(input);

    expect(deps.weeklyPlans.previewWeekPlan).toHaveBeenCalledWith(
      userId,
      householdId,
      weekStart,
      { slots: input.slots },
    );
    expect(deps.weeklyPlans.snapshotWeekAsSlots).toHaveBeenCalledWith(
      userId,
      householdId,
      weekStart,
    );
  });
});
