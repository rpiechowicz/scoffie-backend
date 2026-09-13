import { Test, TestingModule } from '@nestjs/testing';
import { AgentProposalsService } from './agent-proposals.service';
import { PrismaService } from '../../prisma/prisma.service';
import { HouseholdsService } from '../../households/households.service';
import { WeeklyPlansService } from '../../weekly-plans/weekly-plans.service';
import { WeeklyPlansGateway } from '../../weekly-plans/weekly-plans.gateway';
import { ConsentsService } from '../../consents/consents.service';
import { AiUsageCountersService } from '../ai-usage-counters.service';
import { AgentQuotaMailService } from '../agent-quota-mail.service';

// Podmiana DLA JEDNEJ OSOBY nie ma prawa zabrać jedzenia reszcie domu.
//
// Wersja bez tych testów kasowała cały slot i wstawiała jedno danie bez
// uczestników, czyli „dla wszystkich": pytanie „chcę jutro zjeść inne
// śniadanie niż Gaba" kończyło się tym, że Gaba traciła śniadanie, a danie
// pytającego dostawał cały dom. Żaden test tego nie widział, bo wszystkie
// dotyczyły podmiany dla całego gospodarstwa.

const rafal = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const gaba = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const householdId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

const side = (over: Record<string, unknown> = {}) => ({
  recipeId: 'r-new',
  title: 'Omlet z szynką',
  kcalPerServing: 291,
  prepTimeMinutes: 12,
  ...over,
});

const makeDeps = (baseline: unknown[]) => {
  const prisma = { agentProposal: { create: jest.fn().mockResolvedValue({}) } };
  const weeklyPlans = {
    snapshotWeekAsSlots: jest.fn().mockResolvedValue(baseline),
    previewWeekPlan: jest.fn().mockResolvedValue({
      violations: [],
      changes: { created: 1, updated: 0, deleted: 0 },
      slots: [],
      removed: [],
    }),
  };
  const households = {
    memberPreferences: jest.fn().mockResolvedValue([
      { userId: rafal, displayName: 'Rafał', targets: { calorieGoal: 2100 } },
      { userId: gaba, displayName: 'Gaba', targets: { calorieGoal: 1800 } },
    ]),
  };
  return {
    prisma,
    weeklyPlans,
    households,
    counters: {
      resolvePlan: jest.fn().mockResolvedValue({
        tier: 'PRO',
        source: 'ENV',
        periodKey: '2026-08',
        renews: true,
        resetsAt: '2026-10-01T00:00:00.000Z',
        messagesLimit: 200,
        plansLimit: 30,
      }),
      quotaDetailsFor: jest.fn().mockReturnValue(['kind:messages']),
      monthKey: jest.fn(),
      tryConsume: jest.fn(),
      add: jest.fn(),
    },
    plansGateway: { broadcastWeekApplied: jest.fn() },
  };
};

const build = async (deps: ReturnType<typeof makeDeps>) => {
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

const input = (over: Record<string, unknown> = {}) => ({
  userId: rafal,
  householdId,
  conversationId: '11111111-1111-4111-8111-111111111111',
  turnId: '22222222-2222-4222-8222-222222222222',
  weekStart: '2026-08-31',
  dayOfWeek: 'WED',
  mealType: 'BREAKFAST',
  recipeId: 'r-new',
  to: side(),
  from: side({ recipeId: 'r-old', title: 'Jajecznica' }),
  participantIds: [],
  ...over,
});

/** Stan docelowy, który poszedł do policzenia — to on staje się planem. */
const targetSlots = (deps: ReturnType<typeof makeDeps>) =>
  deps.weeklyPlans.previewWeekPlan.mock.calls[0][3].slots as {
    dayOfWeek: string;
    mealType: string;
    recipeId: string;
    participantIds?: string[];
  }[];

describe('createSwapProposal — dla kogo', () => {
  const wspolneSniadanie = {
    dayOfWeek: 'WED',
    mealType: 'BREAKFAST',
    recipeId: 'r-old',
    participantIds: [],
    plannedServings: 2,
  };
  const obiad = {
    dayOfWeek: 'WED',
    mealType: 'LUNCH',
    recipeId: 'r-lunch',
    participantIds: [],
    plannedServings: 2,
  };

  it('podmiana dla JEDNEJ osoby zostawia resztę domu przy swoim daniu', async () => {
    const deps = makeDeps([wspolneSniadanie, obiad]);
    const service = await build(deps);

    await service.createSwapProposal(
      input({ participantIds: [rafal] }) as never,
    );

    const slots = targetSlots(deps);
    const breakfasts = slots.filter((slot) => slot.mealType === 'BREAKFAST');
    expect(breakfasts).toHaveLength(2);

    // Gaba je dalej to samo, tylko już wyłącznie ona.
    const hers = breakfasts.find((slot) => slot.recipeId === 'r-old');
    expect(hers?.participantIds).toEqual([gaba]);

    // Rafał dostaje nowe danie i nikt inny.
    const his = breakfasts.find((slot) => slot.recipeId === 'r-new');
    expect(his?.participantIds).toEqual([rafal]);

    // Reszta dnia nietknięta.
    expect(slots.filter((slot) => slot.mealType === 'LUNCH')).toHaveLength(1);
  });

  it('podmiana dla całego domu nadal WYMIENIA slot', async () => {
    const deps = makeDeps([wspolneSniadanie, obiad]);
    const service = await build(deps);

    await service.createSwapProposal(input() as never);

    const breakfasts = targetSlots(deps).filter(
      (slot) => slot.mealType === 'BREAKFAST',
    );
    expect(breakfasts).toHaveLength(1);
    expect(breakfasts[0].recipeId).toBe('r-new');
    expect(breakfasts[0].participantIds).toBeUndefined();
  });

  it('gdy przy starym daniu nie zostaje nikt, pozycja znika', async () => {
    // Śniadanie było już wydzielone tylko dla Rafała — po podmianie nie ma
    // komu go zostawić, więc trzymanie pustej pozycji byłoby śmieciem.
    const deps = makeDeps([
      { ...wspolneSniadanie, participantIds: [rafal] },
      obiad,
    ]);
    const service = await build(deps);

    await service.createSwapProposal(
      input({ participantIds: [rafal] }) as never,
    );

    const breakfasts = targetSlots(deps).filter(
      (slot) => slot.mealType === 'BREAKFAST',
    );
    expect(breakfasts).toHaveLength(1);
    expect(breakfasts[0].recipeId).toBe('r-new');
  });

  it('karta mówi, KOGO dotyczy podmiana', async () => {
    const deps = makeDeps([wspolneSniadanie]);
    const service = await build(deps);

    await service.createSwapProposal(
      input({ participantIds: [rafal] }) as never,
    );

    const card = deps.prisma.agentProposal.create.mock.calls[0][0].data
      .card as {
      eyebrow: string;
    };
    // Bez imienia karta wygląda identycznie dla zmiany całemu domowi
    // i dla wydzielenia jednej porcji — a tylko jedna z nich zabiera
    // jedzenie reszcie.
    // „tylko Rafał", nie „dla Rafała" — imion nie da się odmieniać regułą.
    expect(card.eyebrow).toBe('Podmiana · środa, śniadanie · tylko Rafał');
  });
});
