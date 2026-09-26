import { Test, TestingModule } from '@nestjs/testing';
import { AgentProposalsService } from './agent-proposals.service';
import { PrismaService } from '../../prisma/prisma.service';
import { HouseholdsService } from '../../households/households.service';
import { WeeklyPlansService } from '../../weekly-plans/weekly-plans.service';
import { WeeklyPlansGateway } from '../../weekly-plans/weekly-plans.gateway';
import { ConsentsService } from '../../consents/consents.service';
import { AiUsageCountersService } from '../ai-usage-counters.service';
import { AgentQuotaMailService } from '../agent-quota-mail.service';

/**
 * `revise_proposal` (workstream, Etap 1): „zamień tylko wtorek" poprawia JEDEN
 * slot propozycji, która czeka na zatwierdzenie — resztę serwis bierze
 * z intencji tamtej propozycji, a nie z pamięci modelu.
 */
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherUser = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const householdId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const conversationId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';
const proposalId = '44444444-4444-4444-8444-444444444444';
const weekStart = '2026-04-13';
const R_MON = '33333333-3333-4333-8333-333333333301';
const R_TUE = '33333333-3333-4333-8333-333333333302';
const R_TUE_SPLIT = '33333333-3333-4333-8333-333333333303';
const R_NEW = '33333333-3333-4333-8333-333333333399';

const WEEK_SLOTS = [
  { dayOfWeek: 'MON', mealType: 'DINNER', recipeId: R_MON },
  {
    dayOfWeek: 'TUE',
    mealType: 'LUNCH',
    recipeId: R_TUE,
    participantIds: [userId],
    plannedServings: 3,
  },
  { dayOfWeek: 'WED', mealType: 'DINNER', recipeId: R_MON },
];

describe('AgentProposalsService.reviseProposal', () => {
  let service: AgentProposalsService;
  const findFirst = jest.fn();

  const input = (over: Record<string, unknown> = {}) => ({
    userId,
    householdId,
    conversationId,
    turnId,
    proposalId,
    dayOfWeek: 'TUE' as const,
    mealType: 'LUNCH' as const,
    recipeId: R_NEW,
    ...over,
  });

  const proposal = (over: Record<string, unknown> = {}) => ({
    kind: 'PLAN_WEEK',
    status: 'PENDING',
    expiresAt: new Date(Date.now() + 60_000),
    weekStart: new Date(`${weekStart}T00:00:00.000Z`),
    action: { slots: WEEK_SLOTS },
    card: { kind: 'PLAN_WEEK' },
    ...over,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentProposalsService,
        { provide: PrismaService, useValue: { agentProposal: { findFirst } } },
        { provide: WeeklyPlansService, useValue: {} },
        { provide: HouseholdsService, useValue: {} },
        { provide: AiUsageCountersService, useValue: {} },
        { provide: AgentQuotaMailService, useValue: {} },
        { provide: WeeklyPlansGateway, useValue: {} },
        { provide: ConsentsService, useValue: {} },
      ],
    }).compile();
    service = module.get(AgentProposalsService);
    jest.spyOn(service, 'createWeekPlanProposal').mockResolvedValue({
      proposed: true,
      proposalId: 'nowa',
    } as never);
    jest.spyOn(service, 'createDayPlanProposal').mockResolvedValue({
      proposed: true,
      proposalId: 'nowa-dnia',
    } as never);
  });

  it('podmienia TYLKO wskazany slot, reszta tygodnia bez zmian', async () => {
    findFirst.mockResolvedValue(proposal());

    await expect(service.reviseProposal(input())).resolves.toMatchObject({
      proposed: true,
    });

    // Propozycja tej rozmowy i tego domu — cudzej nie da się poprawić.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: proposalId, conversationId, householdId },
      }),
    );
    expect(service.createWeekPlanProposal).toHaveBeenCalledWith({
      userId,
      householdId,
      conversationId,
      turnId,
      weekStart,
      slots: [
        WEEK_SLOTS[0],
        // Te same osoby i porcje, nowe danie.
        {
          dayOfWeek: 'TUE',
          mealType: 'LUNCH',
          recipeId: R_NEW,
          participantIds: [userId],
          plannedServings: 3,
        },
        WEEK_SLOTS[2],
      ],
    });
  });

  it('slot rozdzielony na kilka pozycji staje się jednym daniem dla sumy osób', async () => {
    findFirst.mockResolvedValue(
      proposal({
        action: {
          slots: [
            ...WEEK_SLOTS,
            {
              dayOfWeek: 'TUE',
              mealType: 'LUNCH',
              recipeId: R_TUE_SPLIT,
              participantIds: [otherUser],
            },
          ],
        },
      }),
    );
    await service.reviseProposal(input());
    const { slots } = (service.createWeekPlanProposal as jest.Mock).mock
      .calls[0][0] as {
      slots: { dayOfWeek: string; mealType: string }[];
    };
    const tuesday = slots.filter(
      (slot) => slot.dayOfWeek === 'TUE' && slot.mealType === 'LUNCH',
    );
    expect(tuesday).toEqual([
      {
        dayOfWeek: 'TUE',
        mealType: 'LUNCH',
        recipeId: R_NEW,
        participantIds: [userId, otherUser],
      },
    ]);
  });

  it('gdy którakolwiek pozycja slotu była dla całego domu — nowe danie też', async () => {
    findFirst.mockResolvedValue(
      proposal({
        action: {
          slots: [
            ...WEEK_SLOTS,
            { dayOfWeek: 'TUE', mealType: 'LUNCH', recipeId: R_TUE_SPLIT },
          ],
        },
      }),
    );
    await service.reviseProposal(input());
    const { slots } = (service.createWeekPlanProposal as jest.Mock).mock
      .calls[0][0] as {
      slots: Record<string, unknown>[];
    };
    expect(slots).toContainEqual({
      dayOfWeek: 'TUE',
      mealType: 'LUNCH',
      recipeId: R_NEW,
    });
  });

  it('pusty slot: danie dochodzi dla całego domu', async () => {
    findFirst.mockResolvedValue(proposal());
    await service.reviseProposal(input({ dayOfWeek: 'FRI' }));
    const { slots } = (service.createWeekPlanProposal as jest.Mock).mock
      .calls[0][0] as { slots: unknown[] };
    expect(slots).toHaveLength(4);
    expect(slots[3]).toEqual({
      dayOfWeek: 'FRI',
      mealType: 'LUNCH',
      recipeId: R_NEW,
    });
  });

  it('propozycja dnia: nowa propozycja dnia z samym tym dniem', async () => {
    findFirst.mockResolvedValue(
      proposal({ kind: 'PLAN_DAY', card: { date: '2026-04-14' } }),
    );
    await service.reviseProposal(input());
    expect(service.createDayPlanProposal).toHaveBeenCalledWith({
      userId,
      householdId,
      conversationId,
      turnId,
      weekStart,
      dayOfWeek: 'TUE',
      slots: [
        {
          mealType: 'LUNCH',
          recipeId: R_NEW,
          participantIds: [userId],
          plannedServings: 3,
        },
      ],
    });
    expect(service.createWeekPlanProposal).not.toHaveBeenCalled();
  });

  it('propozycja dnia nie poprawia innego dnia', async () => {
    findFirst.mockResolvedValue(
      proposal({ kind: 'PLAN_DAY', card: { date: '2026-04-14' } }),
    );
    await expect(
      service.reviseProposal(input({ dayOfWeek: 'WED' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it.each([
    ['zatwierdzona', { status: 'APPLIED' }, 'AI_PROPOSAL_STALE'],
    ['nieaktualna', { status: 'STALE' }, 'AI_PROPOSAL_STALE'],
    [
      'po terminie',
      { expiresAt: new Date(Date.now() - 1) },
      'AI_PROPOSAL_EXPIRED',
    ],
    ['podmiana, nie plan', { kind: 'SWAP' }, 'AI_PROPOSAL_NOT_FOUND'],
  ])('%s: odmowa %s', async (_label, over, code) => {
    findFirst.mockResolvedValue(proposal(over));
    await expect(service.reviseProposal(input())).rejects.toMatchObject({
      code,
    });
    expect(service.createWeekPlanProposal).not.toHaveBeenCalled();
  });

  it('nie ma jej w tej rozmowie albo numer nie jest UUID: NOT_FOUND', async () => {
    findFirst.mockResolvedValue(null);
    await expect(service.reviseProposal(input())).rejects.toMatchObject({
      code: 'AI_PROPOSAL_NOT_FOUND',
    });
    findFirst.mockClear();
    await expect(
      service.reviseProposal(input({ proposalId: 'P-1' })),
    ).rejects.toMatchObject({ code: 'AI_PROPOSAL_NOT_FOUND' });
    expect(findFirst).not.toHaveBeenCalled();
  });
});
