import { Test, TestingModule } from '@nestjs/testing';
import { AgentProposalsService } from './agent-proposals.service';
import { PrismaService } from '../../prisma/prisma.service';
import { HouseholdsService } from '../../households/households.service';
import { WeeklyPlansService } from '../../weekly-plans/weekly-plans.service';
import { WeeklyPlansGateway } from '../../weekly-plans/weekly-plans.gateway';
import { ConsentsService } from '../../consents/consents.service';
import { AiUsageCountersService } from '../ai-usage-counters.service';
import { AgentQuotaMailService } from '../agent-quota-mail.service';

// AUDYT 12.09.2026 (P1.10). `createHouseholdSplitProposal` sprawdzał, czy
// osoba NALEŻY do gospodarstwa — nie sprawdzał, czy zgodziła się na
// asystenta. Karta „jedno danie, kilka talerzy" niesie obok każdego imienia
// JEGO cel kaloryczny i JEGO ograniczenia, czyli dokładnie to, czego brak
// zgody zabrania pokazywać.
//
// Dziś model tędy nie przejdzie, bo nie zna identyfikatora osoby bez zgody:
// `get_household_context` i rzut planu odfiltrowują takie osoby, zanim
// cokolwiek do niego trafi. Ale to znaczy, że jedyną ochroną była
// NIEZNAJOMOŚĆ UUID-a. Bramka ma stać na regule, nie na tym, czego model
// przypadkiem nie zobaczył — bo nieznajomość znika przy pierwszym nowym
// narzędziu, które poda identyfikator w innym kontekście.

const rafal = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const gaba = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const householdId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

const dish = {
  recipeId: 'r-1',
  title: 'Omlet z szynką',
  kcalPerServing: 291,
  prepTimeMinutes: 12,
};

const makeDeps = (zgodzeni: string[]) => ({
  prisma: { agentProposal: { create: jest.fn().mockResolvedValue({}) } },
  weeklyPlans: {
    snapshotWeekAsSlots: jest.fn().mockResolvedValue([]),
    previewWeekPlan: jest.fn().mockResolvedValue({
      violations: [],
      changes: { created: 1, updated: 0, deleted: 0 },
      slots: [],
      removed: [],
    }),
  },
  households: {
    memberPreferences: jest.fn().mockResolvedValue([
      {
        userId: rafal,
        displayName: 'Rafał',
        targets: { calorieGoal: 2100 },
        dietPreference: 'NONE',
        allergens: [],
      },
      {
        userId: gaba,
        displayName: 'Gaba',
        targets: { calorieGoal: 1800 },
        dietPreference: 'NONE',
        allergens: [],
      },
    ]),
  },
  counters: {
    resolvePlan: jest.fn().mockResolvedValue({
      tier: 'PRO',
      source: 'ENV',
      periodKey: '2026-09',
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
  consents: {
    usersWithValid: (ids: readonly string[]) =>
      Promise.resolve(new Set(ids.filter((id) => zgodzeni.includes(id)))),
  },
});

const build = async (deps: ReturnType<typeof makeDeps>) => {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      AgentProposalsService,
      { provide: PrismaService, useValue: deps.prisma },
      { provide: WeeklyPlansService, useValue: deps.weeklyPlans },
      { provide: HouseholdsService, useValue: deps.households },
      { provide: AiUsageCountersService, useValue: deps.counters },
      {
        provide: AgentQuotaMailService,
        useValue: { announce: jest.fn().mockResolvedValue(undefined) },
      },
      { provide: WeeklyPlansGateway, useValue: deps.plansGateway },
      { provide: ConsentsService, useValue: deps.consents },
    ],
  }).compile();
  return module.get(AgentProposalsService);
};

const input = (portions: { userId: string; note: string | null }[]) => ({
  userId: rafal,
  householdId,
  conversationId: '11111111-1111-4111-8111-111111111111',
  turnId: '22222222-2222-4222-8222-222222222222',
  weekStart: '2026-08-31',
  dayOfWeek: 'WED' as const,
  mealType: 'BREAKFAST' as const,
  recipeId: 'r-1',
  dish,
  portions,
});

describe('createHouseholdSplitProposal — talerz tylko dla osoby ze zgodą', () => {
  const poprzednieWymaganie = process.env.AI_CONSENT_REQUIRED;

  beforeEach(() => {
    process.env.AI_CONSENT_REQUIRED = 'true';
  });

  afterAll(() => {
    if (poprzednieWymaganie === undefined) {
      delete process.env.AI_CONSENT_REQUIRED;
    } else {
      process.env.AI_CONSENT_REQUIRED = poprzednieWymaganie;
    }
  });

  it('domownik BEZ zgody odbija się o PLAN_PARTICIPANT_NOT_IN_HOUSEHOLD', async () => {
    const deps = makeDeps([rafal]);
    const service = await build(deps);

    await expect(
      service.createHouseholdSplitProposal(
        input([
          { userId: rafal, note: 'bez sera' },
          { userId: gaba, note: 'z awokado' },
        ]),
      ),
    ).rejects.toMatchObject({
      response: { code: 'PLAN_PARTICIPANT_NOT_IN_HOUSEHOLD' },
    });

    // Nic nie zostaje policzone ani odłożone — odmowa jest przed zapisem.
    expect(deps.weeklyPlans.previewWeekPlan).not.toHaveBeenCalled();
    expect(deps.prisma.agentProposal.create).not.toHaveBeenCalled();
  });

  it('komunikat odmowy niesie identyfikator, nie imię ani cel', async () => {
    const service = await build(makeDeps([rafal]));

    const blad = await service
      .createHouseholdSplitProposal(
        input([
          { userId: rafal, note: null },
          { userId: gaba, note: null },
        ]),
      )
      .catch((error: unknown) => error);

    // `details` to lista identyfikatorów — model dostaje tyle, żeby wiedzieć,
    // kogo wyrzucić z propozycji, i ani grama profilu tej osoby.
    expect(
      (blad as { response: { details: string[] } }).response.details,
    ).toEqual([gaba]);
  });

  it('cały dom ze zgodą przechodzi normalnie', async () => {
    const deps = makeDeps([rafal, gaba]);
    const service = await build(deps);

    await expect(
      service.createHouseholdSplitProposal(
        input([
          { userId: rafal, note: 'bez sera' },
          { userId: gaba, note: 'z awokado' },
        ]),
      ),
    ).resolves.toBeDefined();

    expect(deps.prisma.agentProposal.create).toHaveBeenCalled();
  });

  it('obcy identyfikator dalej odpada, choćby miał zgodę gdzie indziej', async () => {
    const obcy = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const service = await build(makeDeps([rafal, gaba, obcy]));

    await expect(
      service.createHouseholdSplitProposal(
        input([{ userId: obcy, note: null }]),
      ),
    ).rejects.toMatchObject({
      response: { code: 'PLAN_PARTICIPANT_NOT_IN_HOUSEHOLD' },
    });
  });

  it('AI_CONSENT_REQUIRED=false zdejmuje regułę — tak jak wszędzie indziej', async () => {
    process.env.AI_CONSENT_REQUIRED = 'false';
    const deps = makeDeps([]);
    const service = await build(deps);

    await expect(
      service.createHouseholdSplitProposal(
        input([
          { userId: rafal, note: null },
          { userId: gaba, note: null },
        ]),
      ),
    ).resolves.toBeDefined();
  });
});
