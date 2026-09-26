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
import { WeeklyPlansGateway } from '../../weekly-plans/weekly-plans.gateway';
import { AgentToolContext, AgentToolExecutor } from './agent-tool-executor';
import { createPlanScope } from './plan-scope';
import { AgentPromptService } from '../agent-prompt.service';
import { AgentCatalogService } from '../search/agent-catalog.service';
import { AgentMealPlannerService } from '../planner/agent-meal-planner.service';

// AUDYT 12.09.2026 (P0.3). `apply_week_plan` przyjmuje STAN DOCELOWY: czego
// nie ma na liście, tego nie ma w planie. Pusta lista slotów przechodziła
// walidację i kasowała cały tydzień jednym wywołaniem modelu — bez karty, bez
// potwierdzenia i bez „Cofnij", bo cofnięcie istnieje wyłącznie dla propozycji.
// Nie trzeba było do tego napastnika: wystarczyło, żeby model źle zrozumiał
// „ułóż mi tydzień od nowa".
//
// Bramka trybu (`agent-tool-mode.spec.ts`) pilnuje, KTO zapisuje. Ta pilnuje,
// ILE wolno usunąć bez kliknięcia człowieka — i działa nawet w trybie `off`,
// czyli wtedy, gdy ktoś świadomie zdjął tryb propozycji.

describe('AgentToolExecutor — bramka destrukcyjnego zapisu planu', () => {
  let executor: AgentToolExecutor;
  const applyWeekPlan = jest.fn();
  const recordRejected = jest.fn();
  const tryConsume = jest.fn();
  const countersAdd = jest.fn();

  const context = (): AgentToolContext => ({
    userId: 'u-1',
    householdId: 'h-1',
    catalogIndex: { R01: 'r-1', R02: 'r-2' },
    conversationId: 'c-1',
    turnId: 't-1',
    // Tryb zapisu bezpośredniego — czyli ten, w którym bramka trybu
    // przepuszcza i zostaje wyłącznie ta.
    proposalMode: false,
    collectCard: () => {},
  });

  const slot = (day: string) => ({
    day_of_week: day,
    meal_type: 'DINNER',
    recipe: 'R01',
  });

  /** Wynik `applyWeekPlan` z zadaną liczbą usunięć. */
  const result = (deleted: number, dryRun: boolean) => ({
    applied: !dryRun,
    dryRun,
    violations: [],
    changes: { created: 0, updated: 0, deleted },
    plan: null,
  });

  const apply = (input: Record<string, unknown>) =>
    executor.execute(
      'apply_week_plan',
      { week_start: '2026-08-31', ...input },
      context(),
    );

  beforeEach(async () => {
    jest.clearAllMocks();
    tryConsume.mockResolvedValue(true);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentToolExecutor,
        { provide: HouseholdsService, useValue: {} },
        { provide: WeeklyPlansService, useValue: { applyWeekPlan } },
        { provide: RecipesService, useValue: {} },
        { provide: IngredientsService, useValue: {} },
        { provide: PrismaService, useValue: {} },
        {
          provide: AiUsageCountersService,
          useValue: {
            resolvePlan: jest.fn().mockResolvedValue({
              tier: 'PRO',
              quotaScopeId: 'h-1',
              periodKey: '2026-08',
              plansLimit: 30,
            }),
            tryConsume,
            add: countersAdd,
            quotaDetailsFor: jest.fn().mockReturnValue([]),
          },
        },
        { provide: AgentMetricsService, useValue: { recordRejected } },
        { provide: AgentMemoryService, useValue: {} },
        { provide: AgentProposalsService, useValue: {} },
        { provide: ShoppingListService, useValue: {} },
        { provide: WeeklyPlansGateway, useValue: {} },
        { provide: AgentCatalogService, useValue: {} },
        { provide: AgentMealPlannerService, useValue: {} },
        {
          provide: AgentPromptService,
          useValue: {
            membersForModel: (members: unknown[]) =>
              Promise.resolve({ members, withheld: 0 }),
          },
        },
      ],
    }).compile();
    executor = module.get(AgentToolExecutor);
  });

  /** Ile razy poszedł PRAWDZIWY zapis (nie suchy przebieg). */
  const realWrites = () =>
    applyWeekPlan.mock.calls.filter(
      (call: [string, string, string, { dryRun?: boolean }]) =>
        call[3]?.dryRun !== true,
    ).length;

  it('pusta lista slotów NIE kasuje tygodnia', async () => {
    // Suchy przebieg mówi: ten zapis usunąłby pięć pozycji.
    applyWeekPlan.mockResolvedValue(result(5, true));

    const refused = await apply({ slots: [] });

    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'AI_TOOL_NOT_IN_MODE' },
    });
    expect(realWrites()).toBe(0);
    expect(recordRejected).toHaveBeenCalledWith('destructive');
  });

  it('odmowa mówi ile i czym zamiast — model poprawia się w tej samej turze', async () => {
    applyWeekPlan.mockResolvedValue(result(7, true));

    const refused = await apply({ slots: [slot('MON')] });

    if (refused.ok) throw new Error('oczekiwano odmowy');
    expect(refused.error.message).toContain('7 pozycji');
    expect(refused.error.message).toContain('propose_week_plan');
  });

  it('przemeblowanie wielu dni bez potwierdzenia jest odmawiane', async () => {
    applyWeekPlan.mockResolvedValue(result(3, true));

    const refused = await apply({ slots: [slot('MON'), slot('TUE')] });

    expect(refused.ok).toBe(false);
    expect(realWrites()).toBe(0);
  });

  it('poprawka dwóch dni przechodzi — próg nie blokuje zwykłej pracy', async () => {
    applyWeekPlan.mockImplementation(
      (
        _userId: string,
        _householdId: string,
        _weekStart: string,
        dto: { dryRun?: boolean },
      ) => Promise.resolve(result(2, dto.dryRun === true)),
    );

    const ok = await apply({ slots: [slot('MON'), slot('TUE')] });

    expect(ok.ok).toBe(true);
    expect(realWrites()).toBe(1);
    expect(recordRejected).not.toHaveBeenCalled();
  });

  it('sam dry_run nie jest bramkowany i nie robi drugiego przebiegu', async () => {
    applyWeekPlan.mockResolvedValue(result(9, true));

    const ok = await apply({ slots: [], dry_run: true });

    expect(ok.ok).toBe(true);
    // Dokładnie jedno wywołanie: to, o które poprosił model.
    expect(applyWeekPlan).toHaveBeenCalledTimes(1);
    expect(recordRejected).not.toHaveBeenCalled();
  });

  it('powtórzenie tego samego zapisu jest bezstratne (stan docelowy)', async () => {
    // Drugie wykonanie tej samej operacji nie usuwa niczego więcej: zapis
    // opisuje STAN, nie różnicę. Bramka nie może z tego zrobić odmowy.
    applyWeekPlan.mockImplementation(
      (
        _userId: string,
        _householdId: string,
        _weekStart: string,
        dto: { dryRun?: boolean },
      ) => Promise.resolve(result(0, dto.dryRun === true)),
    );

    const first = await apply({ slots: [slot('MON')] });
    const second = await apply({ slots: [slot('MON')] });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(realWrites()).toBe(2);
    expect(recordRejected).not.toHaveBeenCalled();
  });

  it('gdy suchy przebieg padnie, bramka nie zgaduje — decyduje prawdziwy zapis', async () => {
    // Zmyślony przepis albo zła data: komunikat ma przyjść z domeny, a nie
    // z bramki, która nie wie, co poszło źle.
    applyWeekPlan.mockRejectedValue(new Error('nie ma takiego przepisu'));

    const out = await apply({ slots: [slot('MON')] });

    expect(out.ok).toBe(false);
    expect(recordRejected).not.toHaveBeenCalledWith('destructive');
  });
  it('drugi tydzień w tej samej turze odmawia, zanim dotknie planu', async () => {
    applyWeekPlan.mockImplementation(
      (
        _userId: string,
        _householdId: string,
        _weekStart: string,
        dto: { dryRun?: boolean },
      ) => Promise.resolve(result(0, dto.dryRun === true)),
    );
    const scoped: AgentToolContext = {
      ...context(),
      planScope: createPlanScope(),
      dates: { weekStart: '2026-08-31', clientToday: '2026-09-02' },
    };

    const first = await executor.execute(
      'apply_week_plan',
      { week_start: '2026-08-31', slots: [slot('MON')] },
      scoped,
    );
    applyWeekPlan.mockClear();
    const second = await executor.execute(
      'apply_week_plan',
      { week_start: '2026-09-07', slots: [slot('MON')] },
      scoped,
    );

    expect(first.ok).toBe(true);
    expect(second).toMatchObject({
      ok: false,
      error: { code: 'AI_PLAN_RANGE_EXCEEDED' },
    });
    expect(applyWeekPlan).not.toHaveBeenCalled();
    expect(recordRejected).toHaveBeenCalledWith('planRange');
  });
});
