import { Test, TestingModule } from '@nestjs/testing';
import { HouseholdsService } from '../../households/households.service';
import { IngredientsService } from '../../recipes/ingredients.service';
import { RecipesService } from '../../recipes/recipes.service';
import { WeeklyPlansService } from '../../weekly-plans/weekly-plans.service';
import { AgentMetricsService } from '../../observability/agent-metrics.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentMemoryService } from '../agent-memory.service';
import { AiUsageCountersService } from '../ai-usage-counters.service';
import { AgentProposalsService } from '../proposals/agent-proposals.service';
import { ShoppingListService } from '../../weekly-plans/services/shopping-list.service';
import { AgentToolContext, AgentToolExecutor } from './agent-tool-executor';

// Bramka trybu jest DRUGA po prompcie i jedyna, która nie zależy od tego, czy
// model przeczytał instrukcję. Bez niej „agent tylko proponuje" byłoby
// grzeczną prośbą: narzędzie zapisu jest na liście w obu trybach (prefiks
// cache musi być identyczny), więc wystarczyłoby, żeby model po nie sięgnął.

describe('AgentToolExecutor — bramka trybu', () => {
  let executor: AgentToolExecutor;
  const applyWeekPlan = jest.fn();
  const createWeekPlanProposal = jest.fn();

  const context = (proposalMode: boolean): AgentToolContext => ({
    userId: 'u-1',
    householdId: 'h-1',
    catalogIndex: { R01: 'r-1' },
    conversationId: 'c-1',
    turnId: 't-1',
    proposalMode,
    collectCard: () => {},
  });

  const slots = [
    { day_of_week: 'MON', meal_type: 'DINNER', recipe: 'R01' },
  ];

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentToolExecutor,
        { provide: HouseholdsService, useValue: {} },
        { provide: WeeklyPlansService, useValue: { applyWeekPlan } },
        { provide: RecipesService, useValue: {} },
        { provide: IngredientsService, useValue: {} },
        { provide: PrismaService, useValue: {} },
        { provide: AiUsageCountersService, useValue: {} },
        { provide: AgentMetricsService, useValue: {} },
        { provide: AgentMemoryService, useValue: {} },
        { provide: AgentProposalsService, useValue: { createWeekPlanProposal } },
        { provide: ShoppingListService, useValue: {} },
      ],
    }).compile();
    executor = module.get(AgentToolExecutor);
  });

  it('w trybie propozycji zapis nie dochodzi do domeny', async () => {
    const result = await executor.execute(
      'apply_week_plan',
      { week_start: '2026-08-31', slots },
      context(true),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'AI_TOOL_NOT_IN_MODE' },
    });
    expect(applyWeekPlan).not.toHaveBeenCalled();
  });

  it('odmowa mówi, czego użyć zamiast — model ma się poprawić w jednej rundzie', async () => {
    const refused = await executor.execute(
      'apply_week_plan',
      { week_start: '2026-08-31', slots },
      context(true),
    );
    if (refused.ok) throw new Error('oczekiwano odmowy');
    expect(refused.error.message).toContain('propose_week_plan');

    const other = await executor.execute(
      'propose_week_plan',
      { week_start: '2026-08-31', slots },
      context(false),
    );
    if (other.ok) throw new Error('oczekiwano odmowy');
    expect(other.error.message).toContain('apply_week_plan');
  });

  it('nawet dry_run jest odmawiany — sprawdzanie robi propozycja', async () => {
    const result = await executor.execute(
      'apply_week_plan',
      { week_start: '2026-08-31', slots, dry_run: true },
      context(true),
    );

    expect(result.ok).toBe(false);
    expect(applyWeekPlan).not.toHaveBeenCalled();
  });

  it('w trybie zapisu propozycja nie powstaje', async () => {
    const result = await executor.execute(
      'propose_week_plan',
      { week_start: '2026-08-31', slots },
      context(false),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'AI_TOOL_NOT_IN_MODE' },
    });
    expect(createWeekPlanProposal).not.toHaveBeenCalled();
  });

  it('bramka dotyczy WYŁĄCZNIE tych dwóch narzędzi', async () => {
    // Odczyty muszą działać w obu trybach — inaczej model nie sprawdzi
    // gospodarstwa, zanim cokolwiek zaproponuje.
    for (const mode of [true, false]) {
      const result = await executor.execute(
        'get_household_context',
        {},
        context(mode),
      );
      // Serwis jest pustą atrapą, więc wynik będzie błędem — ale NIE tym.
      if (!result.ok) {
        expect(result.error.code).not.toBe('AI_TOOL_NOT_IN_MODE');
      }
    }
  });
});
