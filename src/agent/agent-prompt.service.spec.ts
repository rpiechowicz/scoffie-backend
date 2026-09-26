import { ConsentsService } from '../consents/consents.service';
import { HouseholdsService } from '../households/households.service';
import { PrismaService } from '../prisma/prisma.service';
import { WeeklyPlansService } from '../weekly-plans/weekly-plans.service';
import { AgentMemoryService } from './agent-memory.service';
import { AgentPromptService } from './agent-prompt.service';
import { AgentCatalogService } from './search/agent-catalog.service';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('AgentPromptService.membersForModel', () => {
  const original = process.env.AI_CONSENT_REQUIRED;
  let consents: { usersWithValid: jest.Mock };
  let service: AgentPromptService;
  const members = [
    { userId: A, displayName: 'Ania' },
    { userId: B, displayName: 'Bartek' },
  ];

  beforeEach(() => {
    consents = { usersWithValid: jest.fn().mockResolvedValue(new Set([A])) };
    service = new AgentPromptService(
      {} as PrismaService,
      {} as HouseholdsService,
      {} as AgentMemoryService,
      consents as unknown as ConsentsService,
      {} as WeeklyPlansService,
      {} as AgentCatalogService,
    );
  });

  afterEach(() => {
    if (original === undefined) delete process.env.AI_CONSENT_REQUIRED;
    else process.env.AI_CONSENT_REQUIRED = original;
  });

  it('bez bramki zgód (jawne false): wszyscy domownicy, bez pytania o zgody', async () => {
    process.env.AI_CONSENT_REQUIRED = 'false';
    const result = await service.membersForModel(members);
    expect(result).toEqual({ members, withheld: 0 });
    expect(consents.usersWithValid).not.toHaveBeenCalled();
  });

  it('z bramką: do modelu idą tylko domownicy z własną zgodą, reszta jest policzona', async () => {
    // Zgoda Ani nie obejmuje Bartka — jego alergie to jego dane o zdrowiu.
    process.env.AI_CONSENT_REQUIRED = 'true';
    const result = await service.membersForModel(members);
    expect(result.members.map((m) => m.userId)).toEqual([A]);
    expect(result.withheld).toBe(1);
    expect(consents.usersWithValid).toHaveBeenCalledWith(
      [A, B],
      'AI_ASSISTANT',
    );
  });
});

describe('AgentPromptService.build — plan tygodnia w bloku gospodarstwa', () => {
  const original = process.env.AI_CONSENT_REQUIRED;
  const RECIPE = 'rrrrrrrr-rrrr-4rrr-8rrr-rrrrrrrrrrrr';
  let getByHouseholdAndWeek: jest.Mock;
  let service: AgentPromptService;

  const planItem = {
    dayOfWeek: 'TUESDAY',
    mealType: 'LUNCH',
    recipeId: RECIPE,
    plannedServings: 2,
    // Ania ma zgodę, Bartek nie — jego identyfikator nie może trafić do modelu.
    participantIds: [A, B],
    eatenByUserIds: [],
    recipe: {
      title: 'Kurczak z ryżem',
      servings: 2,
      prepTimeMinutes: 30,
      nutritionKcal: 1200,
    },
  };

  const householdBlock = async () =>
    (
      await service.build(
        A,
        'h-1',
        {
          weekStart: '2026-09-21',
          clientToday: '2026-09-22',
          timeZone: 'Europe/Warsaw',
        },
        true,
      )
    ).system[2].text;

  beforeEach(() => {
    process.env.AI_CONSENT_REQUIRED = 'true';
    getByHouseholdAndWeek = jest
      .fn()
      .mockResolvedValue({ weekStart: '2026-09-21', items: [planItem] });
    const prisma = {
      recipe: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: RECIPE,
            title: 'Kurczak z ryżem',
            mealType: 'LUNCH',
            suitableMealTypes: ['LUNCH'],
            prepTimeMinutes: 30,
            servings: 2,
            nutritionKcal: 1200,
            nutritionProtein: 80,
            nutritionFat: 30,
            nutritionCarbs: 120,
            allergens: [],
            dietTags: [],
            ingredients: [],
          },
        ]),
      },
      household: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ name: 'Dom', enabledMealTypes: ['LUNCH'] }),
      },
    };
    service = new AgentPromptService(
      prisma as unknown as PrismaService,
      {
        memberPreferences: jest.fn().mockResolvedValue([
          { userId: A, displayName: 'Ania', targets: {} },
          { userId: B, displayName: 'Bartek', targets: {} },
        ]),
      } as unknown as HouseholdsService,
      {
        promptBlock: jest.fn().mockResolvedValue(''),
      } as unknown as AgentMemoryService,
      {
        usersWithValid: jest.fn().mockResolvedValue(new Set([A])),
      } as unknown as ConsentsService,
      { getByHouseholdAndWeek } as unknown as WeeklyPlansService,
      // Prawdziwy serwis katalogu na tym samym mocku bazy: bez `aggregate`
      // odcisk wersji się nie liczy i indeks buduje się przy każdej turze.
      new AgentCatalogService(prisma as unknown as PrismaService),
    );
  });

  afterEach(() => {
    if (original === undefined) delete process.env.AI_CONSENT_REQUIRED;
    else process.env.AI_CONSENT_REQUIRED = original;
  });

  it('plan planowanego tygodnia jest w bloku w kształcie get_week_plan, z filtrem zgód', async () => {
    const block = await householdBlock();
    expect(getByHouseholdAndWeek).toHaveBeenCalledWith(A, 'h-1', '2026-09-21');

    const open = block.indexOf('<plan>');
    const close = block.indexOf('</plan>');
    expect(open).toBeGreaterThan(-1);
    const plan = JSON.parse(block.slice(open + '<plan>'.length, close)) as {
      items: Record<string, unknown>[];
    };
    // Indeks katalogu zamiast UUID, kalorie na porcję — jak w narzędziu.
    expect(plan.items[0]).toMatchObject({
      recipe: 'R01',
      title: 'Kurczak z ryżem',
      kcalPerServing: 600,
      participants: [A],
      othersCount: 1,
    });
    // Domownik bez zgody zostaje liczbą: jego identyfikatora nie ma nigdzie.
    expect(block).not.toContain(B);
  });

  it('pusty tydzień mówi wprost, że nic nie zaplanowano', async () => {
    getByHouseholdAndWeek.mockResolvedValue({
      weekStart: '2026-09-21',
      items: [],
    });
    const block = await householdBlock();
    expect(block).toContain('PLAN PLANOWANEGO TYGODNIA: pusty');
    expect(block).not.toContain('<plan>');
  });

  it('błąd odczytu planu nie wywraca tury — bloku planu po prostu nie ma', async () => {
    getByHouseholdAndWeek.mockRejectedValue(new Error('baza padła'));
    const block = await householdBlock();
    expect(block).not.toContain('PLAN PLANOWANEGO TYGODNIA');
    expect(block).toContain('GOSPODARSTWO:');
  });
});
