import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  AgentToolContext,
  AgentToolExecutor,
  AgentToolResult,
} from '../src/agent/tools/agent-tool-executor';
import { AGENT_TOOL_NAMES } from '../src/agent/tools/agent-tools';
import {
  AgentMemoryService,
  MEMORY_LIMIT,
} from '../src/agent/agent-memory.service';
import { AgentPromptService } from '../src/agent/agent-prompt.service';
import { AgentCard } from '../src/agent/cards/agent-cards';
import { AgentProposalsService } from '../src/agent/proposals/agent-proposals.service';
import {
  buildCatalogDigest,
  loadDigestRecipes,
} from '../src/agent/catalog-digest';
import { LEGAL_DOCUMENT_VERSIONS } from '../src/common/legal-documents';

/**
 * Narzędzia asystenta na żywej bazie — bez ani jednego wywołania modelu.
 *
 * Schemat narzędzia może wyglądać poprawnie i mimo to nie odpowiadać żadnej
 * istniejącej operacji; ta suita jest dowodem, że każde narzędzie NAPRAWDĘ coś
 * robi w domenie. Sprawdza też regułę, na której stoi cała pętla asystenta:
 * błąd wraca jako DANE z kodem, a nie jako wyjątek — model ma go poprawić, nie
 * wywrócić turę.
 */
const WEEK_START = '2026-09-28';
// Ta sama reguła co w `AgentPromptService.loadDigest()`: gospodarstwo
// katalogowe ma inne id na dev, w CI i na produkcji. Wpisane na sztywno
// znaczyło, że na maszynie z prawdziwym katalogiem cała suita padała na
// „katalog dev nie ma kolacji" — czyli mówiła o katalogu, którego nie czytała.
const CATALOG_HOUSEHOLD =
  (process.env.RECIPE_IMPORT_HOUSEHOLD_ID ?? '').trim() ||
  '22222222-2222-4222-8222-222222222222';

describe('Narzędzia asystenta E2E', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let executor: AgentToolExecutor;
  let memory: AgentMemoryService;
  let prompts: AgentPromptService;
  let context: AgentToolContext;
  /// Karty bez skutków ubocznych (pytanie, zestawienie) — w turze zbiera je
  /// runner; tutaj zbieramy je sami, żeby dało się je sprawdzić.
  const collectedCards: AgentCard[] = [];

  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];

  let firstCatalogIndex: string;
  /// Drugi przepis na kolację — podmiana bez dwóch dań nie jest podmianą.
  let secondCatalogIndex: string;

  const run = (name: string, input: Record<string, unknown> = {}) =>
    executor.execute(name, input, context);

  const data = <T>(result: AgentToolResult): T => {
    if (!result.ok) {
      throw new Error(`oczekiwano sukcesu, dostano ${result.error.code}`);
    }
    return result.data as T;
  };

  beforeAll(async () => {
    // Bramka zgód domyślnie włączona; narzędzia testujemy bez klikania zgód.
    process.env.AI_CONSENT_REQUIRED = 'false';
    // PLAN JAWNIE, NIE Z DOMYŚLNEJ WARTOŚCI. Do 4.09.2026 brak
    // `AI_TIER_OVERRIDE` znaczył „PRO dla wszystkich", więc ta suita dostawała
    // pulę domu z miesiąca kalendarzowego, nie wiedząc o tym. Po zmianie
    // domyślnej wartości (skasowanie zmiennej w Railway rozdawało asystenta za
    // darmo) taki dom wpada na PRÓBĘ: pięć wiadomości i licznik w zakresie
    // `trial:<hasz>`, a nie `householdId`. Ta suita testuje asystenta, nie
    // paywall, więc mówi wprost, czego oczekuje.
    process.env.AI_TIER_OVERRIDE = 'PRO';
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    executor = moduleRef.get(AgentToolExecutor);
    memory = moduleRef.get(AgentMemoryService);
    prompts = moduleRef.get(AgentPromptService);

    const stamp = `${Date.now()}`;
    const user = await prisma.user.create({
      data: {
        displayName: `Narzędziowiec ${stamp}`,
        email: `tools-${stamp}@agent.local`,
        authProvider: 'DEV',
      },
      select: { id: true },
    });
    createdUserIds.push(user.id);

    const household = await prisma.household.create({
      data: { name: `Dom narzędzi ${stamp}`, createdById: user.id },
      select: { id: true },
    });
    createdHouseholdIds.push(household.id);
    await prisma.membership.create({
      data: { userId: user.id, householdId: household.id, role: 'OWNER' },
    });

    const recipes = await loadDigestRecipes(prisma, CATALOG_HOUSEHOLD);
    const digest = buildCatalogDigest(recipes);
    // Indeks przepisu, który NADAJE SIĘ na kolację — inaczej `apply_week_plan`
    // słusznie odmówi (RECIPE_NOT_SUITABLE_FOR_SLOT) i test mierzyłby co innego.
    const dinnerPosition = recipes.findIndex((recipe) =>
      (recipe.suitableMealTypes.length > 0
        ? recipe.suitableMealTypes
        : [recipe.mealType]
      ).includes('DINNER'),
    );
    if (dinnerPosition < 0) throw new Error('katalog dev nie ma kolacji');
    firstCatalogIndex = Object.keys(digest.index)[dinnerPosition];
    const secondDinner = recipes.findIndex(
      (recipe, position) =>
        position !== dinnerPosition &&
        (recipe.suitableMealTypes.length > 0
          ? recipe.suitableMealTypes
          : [recipe.mealType]
        ).includes('DINNER'),
    );
    if (secondDinner < 0) throw new Error('katalog ma tylko jedną kolację');
    secondCatalogIndex = Object.keys(digest.index)[secondDinner];

    // Rozmowa musi istnieć NAPRAWDĘ: propozycja wisi na niej kluczem obcym
    // (kaskada z rozmowy to RODO), a zatwierdzenie dopisuje do niej wiadomość.
    const conversation = await prisma.agentConversation.create({
      data: { userId: user.id, householdId: household.id },
    });

    context = {
      userId: user.id,
      householdId: household.id,
      catalogIndex: digest.index,
      // Kontekst tury — od propozycji planu narzędzia muszą wiedzieć,
      // do której rozmowy i tury przypiąć wynik.
      conversationId: conversation.id,
      turnId: '00000000-0000-4000-8000-00000000c0a2',
      // Domyślnie stary tor: reszta tej suity sprawdza zapis wprost.
      proposalMode: false,
      scopeUserIds: [],
      collectCard: (card) => collectedCards.push(card),
    };
  });

  afterAll(async () => {
    await prisma.recipe.deleteMany({
      where: { householdId: { in: createdHouseholdIds } },
    });
    await prisma.household.deleteMany({
      where: { id: { in: createdHouseholdIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await moduleRef.close();
    // Suity biegną w jednym procesie (`--runInBand`), więc zmienna zostawiona
    // po sobie przestawiłaby plan następnej.
    delete process.env.AI_TIER_OVERRIDE;
    delete process.env.AI_CONSENT_REQUIRED;
  });

  it('każde zadeklarowane narzędzie jest obsłużone', async () => {
    // Schemat bez implementacji to obietnica, której model nie może spełnić.
    for (const name of AGENT_TOOL_NAMES) {
      const result = await run(name, {});
      if (!result.ok) {
        expect(result.error.code).not.toBe('BAD_REQUEST');
      }
    }
  });

  it('nieznane narzędzie wraca jako dane, nie jako wyjątek', async () => {
    const result = await run('zrob_kawe');
    expect(result).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
  });

  it('get_household_context oddaje domowników z celami', async () => {
    const members = data<{ userId: string; targets: unknown }[]>(
      await run('get_household_context'),
    );
    expect(members).toHaveLength(1);
    expect(members[0]).toHaveProperty('targets');
    // Sylwetka (płeć, wzrost, waga, rok urodzenia) nie ma prawa wyjść do
    // modelu — to dane o zdrowiu domowników, a cele są już policzone.
    expect(members[0]).not.toHaveProperty('body');
    const serialized = JSON.stringify(members);
    for (const field of ['sex', 'heightCm', 'weightKg', 'yearOfBirth']) {
      expect(serialized).not.toContain(`"${field}"`);
    }
  });

  it('search_ingredients znajduje składnik i podaje jednostki', async () => {
    const hits = data<{ id: string; allowedUnits: string[] }[]>(
      await run('search_ingredients', { query: 'cebula', limit: 3 }),
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].allowedUnits).toContain('g');
  });

  it('apply_week_plan z dry_run niczego nie zapisuje', async () => {
    const result = data<{ applied: boolean; changes: { created: number } }>(
      await run('apply_week_plan', {
        week_start: WEEK_START,
        dry_run: true,
        slots: [
          {
            day_of_week: 'MON',
            meal_type: 'DINNER',
            recipe: firstCatalogIndex,
          },
        ],
      }),
    );
    expect(result.applied).toBe(false);
    expect(result.changes.created).toBe(1);

    const plan = data<{ items: unknown[] }>(
      await run('get_week_plan', { week_start: WEEK_START }),
    );
    expect(plan.items).toHaveLength(0);
  });

  it('indeks katalogu (R01) tłumaczy się na prawdziwy przepis', async () => {
    const result = data<{ applied: boolean }>(
      await run('apply_week_plan', {
        week_start: WEEK_START,
        slots: [
          {
            day_of_week: 'MON',
            meal_type: 'DINNER',
            recipe: firstCatalogIndex,
          },
        ],
      }),
    );
    // Gdyby indeks nie został rozwiązany, `applyWeekPlan` zwróciłby naruszenie
    // RECIPE_NOT_FOUND zamiast zapisać tydzień.
    expect(result.applied).toBe(true);

    // …i wraca tym samym indeksem, którym model o niego poprosił. To jest
    // pełna pętla: R07 → zapis → odczyt → R07, więc model może wziąć
    // referencję z planu i włożyć ją prosto do kolejnego narzędzia.
    const plan = data<{ items: { recipe: string }[] }>(
      await run('get_week_plan', { week_start: WEEK_START }),
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].recipe).toBe(firstCatalogIndex);
  });

  it('get_week_balance liczy zaplanowany dzień', async () => {
    const balance = data<{
      days: { dayOfWeek: string; planned: { kcal: number } }[];
    }>(await run('get_week_balance', { week_start: WEEK_START }));
    const monday = balance.days.find((day) => day.dayOfWeek === 'MON');
    expect(monday?.planned.kcal).toBeGreaterThan(0);
  });

  it('zmyślony indeks katalogu wraca z czytelnym błędem, nie „to nie UUID"', async () => {
    const result = await run('apply_week_plan', {
      week_start: WEEK_START,
      slots: [{ day_of_week: 'MON', meal_type: 'DINNER', recipe: 'R999' }],
    });

    // Model mówi indeksami, więc komunikat też musi mówić indeksami —
    // inaczej nie ma z czego się poprawić i pętla kręci się w kółko.
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'RECIPE_NOT_FOUND' },
    });
    if (!result.ok) {
      expect(result.error.message).toContain('R999');
      expect(result.error.details).toContain('R999');
    }
  });

  it('danie nie do tego posiłku wraca jako naruszenie, nie wyjątek', async () => {
    const breakfastOnly = await prisma.recipe.findFirst({
      where: {
        isCatalog: true,
        isActive: true,
        NOT: {
          OR: [
            { suitableMealTypes: { has: 'DINNER' } },
            { mealType: 'DINNER', suitableMealTypes: { isEmpty: true } },
          ],
        },
      },
      select: { id: true },
    });
    const result = data<{ applied: boolean; violations: { code: string }[] }>(
      await run('apply_week_plan', {
        week_start: WEEK_START,
        dry_run: true,
        slots: [
          {
            day_of_week: 'TUE',
            meal_type: 'DINNER',
            recipe: breakfastOnly!.id,
          },
        ],
      }),
    );
    expect(result.applied).toBe(false);
    expect(result.violations[0].code).toBe('RECIPE_NOT_SUITABLE_FOR_SLOT');
  });

  describe('pętla przepisu', () => {
    let recipeId: string;

    it('create_recipe buduje przepis ze składników z wyszukiwarki', async () => {
      const hits = data<{ id: string; allowedUnits: string[] }[]>(
        await run('search_ingredients', {
          query: 'ryż',
          only_with_nutrition: true,
          limit: 1,
        }),
      );
      const recipe = data<{
        id: string;
        kcalPerServing: number;
        ingredientCount: number;
      }>(
        await run('create_recipe', {
          title: 'Danie asystenta',
          meal_type: 'DINNER',
          servings: 2,
          prep_time_minutes: 15,
          ingredients: [{ ingredient_id: hits[0].id, amount: 200, unit: 'g' }],
          steps: [{ text: 'Ugotuj.' }, { text: 'Podawaj.' }],
        }),
      );
      recipeId = recipe.id;
      // Makra liczy serwer — model ich nie podawał i nie mógł. Wynik oddaje je
      // NA PORCJĘ, tak jak katalog i plan; w bazie siedzą dla całego przepisu.
      expect(recipe.kcalPerServing).toBeGreaterThan(0);
      expect(recipe.ingredientCount).toBe(1);
    });

    it('pominięty czas przygotowania nie wywraca zapisu', async () => {
      // Schemat narzędzia miał to pole jako opcjonalne, a DTO wymaga >= 1 —
      // model dostawał „prepTimeMinutes must not be less than 1" o polu,
      // którego wedle schematu nie musiał podawać, i nie miał jak się poprawić.
      const hits = data<{ id: string }[]>(
        await run('search_ingredients', {
          query: 'ziemniak',
          only_with_nutrition: true,
          limit: 1,
        }),
      );
      const recipe = data<{ id: string; prepTimeMinutes: number }>(
        await run('create_recipe', {
          title: 'Danie bez podanego czasu',
          meal_type: 'DINNER',
          servings: 2,
          ingredients: [{ ingredient_id: hits[0].id, amount: 300, unit: 'g' }],
        }),
      );
      expect(recipe.prepTimeMinutes).toBeGreaterThanOrEqual(1);
      await prisma.recipe.deleteMany({ where: { id: recipe.id } });
    });

    it('update_recipe poprawia tytuł', async () => {
      const updated = data<{ title: string }>(
        await run('update_recipe', {
          recipe_id: recipeId,
          title: 'Danie asystenta, poprawione',
        }),
      );
      expect(updated.title).toBe('Danie asystenta, poprawione');
    });

    it('delete_recipe wycofuje przepis', async () => {
      const result = data<{ isActive: boolean }>(
        await run('delete_recipe', { recipe_id: recipeId }),
      );
      expect(result.isActive).toBe(false);
    });

    it('edycja przepisu z katalogu wraca jako błąd z kodem', async () => {
      const catalogRecipeId = context.catalogIndex[firstCatalogIndex];
      const result = await run('update_recipe', {
        recipe_id: catalogRecipeId,
        title: 'Podmiana katalogu',
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'RECIPE_NOT_EDITABLE' },
      });
    });
  });

  /**
   * Pamięć między rozmowami (`remember_note` + `AgentMemory`).
   *
   * Model widzi historię tylko w obrębie JEDNEJ rozmowy, więc bez tej tabeli
   * każda nowa rozmowa zaczynała od zera. Te przypadki pilnują trzech rzeczy:
   * że notatka naprawdę wraca do promptu, że nie da się jej zdublować i że
   * pamięć ma sufit.
   */
  describe('pamięć asystenta', () => {
    beforeEach(async () => {
      await prisma.agentMemory.deleteMany({
        where: { householdId: context.householdId },
      });
    });

    it('remember_note zapisuje notatkę i oddaje ją jako dane', async () => {
      const note = data<{ id: string; text: string }>(
        await run('remember_note', { text: '  W środy jedzą u teściów.  ' }),
      );
      expect(note.text).toBe('W środy jedzą u teściów.');

      const stored = await memory.list(context.householdId);
      expect(stored.map((item) => item.text)).toEqual([
        'W środy jedzą u teściów.',
      ]);
    });

    it('notatka wraca do PROMPTU tury — inaczej pamięć jest tylko tabelą', async () => {
      await run('remember_note', { text: 'Kuba nie je ryb' });

      const prompt = await prompts.build(
        context.userId,
        context.householdId,
        {
          weekStart: WEEK_START,
          clientToday: WEEK_START,
          timeZone: 'Europe/Warsaw',
        },
        false,
      );

      // Blok gospodarstwa jest ostatni — pamięć siedzi w nim, poza punktem cache.
      const householdBlock = prompt.system[prompt.system.length - 1].text;
      expect(householdBlock).toContain('Kuba nie je ryb');
    });

    it('ta sama treść drugi raz nie tworzy duplikatu', async () => {
      await run('remember_note', { text: 'Mają Thermomixa' });
      await run('remember_note', { text: 'mają thermomixa' });

      expect(await memory.list(context.householdId)).toHaveLength(1);
    });

    it('pusta notatka wraca jako błąd walidacji, nie jako wyjątek', async () => {
      const result = await run('remember_note', { text: '   ' });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_ERROR' },
      });
    });

    it('znak % w treści nie działa jak wieloznacznik', async () => {
      // Porównanie „bez rozróżniania wielkości liter" Prisma kompiluje do
      // ILIKE, więc treść notatki bywała WZORCEM: „100% mięsa" pasowało do
      // „100 dag mięsa" i druga notatka po cichu nie powstawała.
      await run('remember_note', { text: 'Kuba je 100 dag mięsa tygodniowo' });
      await run('remember_note', { text: 'Kuba je 100% mięsa tygodniowo' });

      expect(await memory.list(context.householdId)).toHaveLength(2);
    });

    it('za długa notatka wraca jako błąd, nie jako ogryzek zdania', async () => {
      // Ciche ucięcie znaczyłoby, że model dostaje `ok` i uważa, że zapamiętał
      // całość, a w bazie leży pół zdania.
      const result = await run('remember_note', { text: 'a'.repeat(300) });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_ERROR' },
      });
      expect(await memory.list(context.householdId)).toHaveLength(0);
    });

    it('po przekroczeniu limitu wypada NAJSTARSZA notatka', async () => {
      for (let i = 0; i < MEMORY_LIMIT + 2; i += 1) {
        await memory.remember(
          context.householdId,
          context.userId,
          `Notatka numer ${i}`,
        );
      }

      const stored = await memory.list(context.householdId);
      expect(stored).toHaveLength(MEMORY_LIMIT);
      // Świeższa prawda wypiera starszą: przeprowadzka i zmiana diety mają
      // przebić to, co ktoś powiedział pół roku temu.
      const texts = stored.map((item) => item.text);
      expect(texts).toContain(`Notatka numer ${MEMORY_LIMIT + 1}`);
      expect(texts).not.toContain('Notatka numer 0');
    });
  });

  /**
   * Miesięczna kwota planów (`AI_LIMIT_PLANS_PER_MONTH`).
   *
   * Do tej pory zmienna była czytana z env i nieegzekwowana przez nic — limit
   * istniał w dokumentacji i w `.env.example`, a asystent zapisywał plany bez
   * ograniczeń. Te przypadki pilnują nie tylko odmowy, ale przede wszystkim
   * tego, CO kwoty NIE zjada: próba bez zapisu i zapis, który nic nie zmienił.
   */
  describe('miesięczna kwota planów', () => {
    const QUOTA_WEEK = '2026-10-05';
    const periodKey = new Date().toISOString().slice(0, 7);
    let previousLimit: string | undefined;

    const plansUsed = async (): Promise<number> => {
      const row = await prisma.aiUsageCounter.findUnique({
        where: {
          scopeId_periodKey_kind: {
            scopeId: context.householdId,
            periodKey,
            kind: 'plans',
          },
        },
        select: { value: true },
      });
      return row?.value ?? 0;
    };

    const resetQuota = async (limit: number): Promise<void> => {
      process.env.AI_LIMIT_PLANS_PER_MONTH = String(limit);
      await prisma.aiUsageCounter.deleteMany({
        where: { scopeId: context.householdId, periodKey, kind: 'plans' },
      });
    };

    const slot = (dayOfWeek: string) => ({
      day_of_week: dayOfWeek,
      meal_type: 'DINNER',
      recipe: firstCatalogIndex,
    });

    beforeAll(() => {
      previousLimit = process.env.AI_LIMIT_PLANS_PER_MONTH;
    });

    afterAll(async () => {
      if (previousLimit === undefined) {
        delete process.env.AI_LIMIT_PLANS_PER_MONTH;
      } else {
        process.env.AI_LIMIT_PLANS_PER_MONTH = previousLimit;
      }
      await prisma.aiUsageCounter.deleteMany({
        where: { scopeId: context.householdId, periodKey },
      });
    });

    it('po wyczerpaniu limitu zapis jest ODMAWIANY, a nie cofany', async () => {
      await resetQuota(1);
      const first = data<{ applied: boolean }>(
        await run('apply_week_plan', {
          week_start: QUOTA_WEEK,
          slots: [slot('MON')],
        }),
      );
      expect(first.applied).toBe(true);

      const second = await run('apply_week_plan', {
        week_start: QUOTA_WEEK,
        slots: [slot('MON'), slot('TUE')],
      });
      expect(second).toMatchObject({
        ok: false,
        error: { code: 'AI_PLAN_QUOTA_EXCEEDED' },
      });

      // Sedno: kwota schodzi PRZED zapisem, więc odmowa znaczy, że w bazie
      // nic się nie zmieniło. Gdyby liczyła się po zapisie, wtorek już by tu był.
      const plan = data<{ items: { dayOfWeek: string }[] }>(
        await run('get_week_plan', { week_start: QUOTA_WEEK }),
      );
      expect(plan.items.map((item) => item.dayOfWeek)).toEqual(['MON']);
    });

    it('dry_run nie zjada kwoty — to tylko rachunek próbny', async () => {
      await resetQuota(1);
      const preview = data<{ applied: boolean }>(
        await run('apply_week_plan', {
          week_start: QUOTA_WEEK,
          dry_run: true,
          slots: [slot('WED')],
        }),
      );
      expect(preview.applied).toBe(false);
      expect(await plansUsed()).toBe(0);
    });

    it('naruszenie zwraca kwotę — nieudany zapis nie kosztuje planu', async () => {
      await resetQuota(1);
      const rejected = data<{ applied: boolean; violations: unknown[] }>(
        await run('apply_week_plan', {
          week_start: QUOTA_WEEK,
          slots: [{ ...slot('THU'), meal_type: 'BREAKFAST' }],
        }),
      );
      expect(rejected.applied).toBe(false);
      expect(rejected.violations).not.toHaveLength(0);
      expect(await plansUsed()).toBe(0);

      // Skoro kwota wróciła, jedyny dostępny plan musi jeszcze przejść.
      const accepted = data<{ applied: boolean }>(
        await run('apply_week_plan', {
          week_start: QUOTA_WEEK,
          slots: [slot('FRI')],
        }),
      );
      expect(accepted.applied).toBe(true);
    });

    it('powtórzenie tego samego stanu nie kosztuje drugiego planu', async () => {
      await resetQuota(10);
      const slots = [slot('MON'), slot('TUE')];
      data(await run('apply_week_plan', { week_start: QUOTA_WEEK, slots }));
      expect(await plansUsed()).toBe(1);

      // Model, który upewnia się, że zapisał, nie ma prawa spalić komuś
      // limitu na kolejny tydzień.
      const again = data<{ applied: boolean; changes: { created: number } }>(
        await run('apply_week_plan', { week_start: QUOTA_WEEK, slots }),
      );
      expect(again.applied).toBe(true);
      expect(again.changes.created).toBe(0);
      expect(await plansUsed()).toBe(1);
    });
  });

  // Tryb propozycji na żywej bazie: cała obietnica „agent proponuje, człowiek
  // zatwierdza" sprowadza się do jednego faktu — po turze plan jest TAKI SAM.
  describe('tryb propozycji', () => {
    const PROPOSAL_WEEK = '2026-10-26';
    let proposals: AgentProposalsService;

    /** Ile pozycji ma NAPRAWDĘ ten tydzień w bazie — jedyny uczciwy dowód. */
    const weekSlots = (weekStart: string): Promise<number> =>
      prisma.planItem.count({
        where: {
          weeklyPlan: {
            householdId: context.householdId,
            weekStart: new Date(`${weekStart}T00:00:00.000Z`),
          },
        },
      });

    const plansUsed = async (): Promise<number> => {
      const row = await prisma.aiUsageCounter.findUnique({
        where: {
          scopeId_periodKey_kind: {
            scopeId: context.householdId,
            periodKey: new Date().toISOString().slice(0, 7),
            kind: 'plans',
          },
        },
        select: { value: true },
      });
      return row?.value ?? 0;
    };

    /**
     * Propozycja bez `messageId` jest z definicji nieosiągalna (tura padła
     * w połowie). W prawdziwej turze przypina ją runner przy domykaniu.
     */
    const attachAndApply = async (proposalId: string) => {
      const message = await prisma.agentMessage.create({
        data: {
          conversationId: context.conversationId,
          role: 'ASSISTANT',
          kind: 'PLAN_DAY',
          text: 'Proponuję ten dzień.',
        },
      });
      await prisma.agentProposal.update({
        where: { id: proposalId },
        data: { messageId: message.id },
      });
      return proposals.apply(context.userId, proposalId);
    };

    beforeAll(() => {
      proposals = moduleRef.get(AgentProposalsService);
      context.proposalMode = true;
    });

    afterAll(async () => {
      context.proposalMode = false;
      await prisma.agentProposal.deleteMany({
        where: { conversationId: context.conversationId },
      });
    });

    it('apply_week_plan odmawia i mówi, czego użyć zamiast', async () => {
      const result = await run('apply_week_plan', {
        week_start: PROPOSAL_WEEK,
        slots: [
          {
            day_of_week: 'MON',
            meal_type: 'DINNER',
            recipe: firstCatalogIndex,
          },
        ],
      });

      expect(result).toMatchObject({
        ok: false,
        error: { code: 'AI_TOOL_NOT_IN_MODE' },
      });
      if (result.ok) throw new Error('nieosiągalne');
      expect(result.error.message).toContain('propose_week_plan');
    });

    it('propozycja niczego nie zapisuje ani nie zjada kwoty planów', async () => {
      const before = await plansUsed();

      const proposed = data<{ proposed: boolean; proposalId: string }>(
        await run('propose_week_plan', {
          week_start: PROPOSAL_WEEK,
          slots: [
            {
              day_of_week: 'MON',
              meal_type: 'DINNER',
              recipe: firstCatalogIndex,
            },
          ],
        }),
      );

      expect(proposed.proposed).toBe(true);
      expect(await weekSlots(PROPOSAL_WEEK)).toBe(0);
      expect(await plansUsed()).toBe(before);

      const row = await prisma.agentProposal.findUnique({
        where: { id: proposed.proposalId },
      });
      expect(row).toMatchObject({ status: 'PENDING', kind: 'PLAN_WEEK' });
    });

    it('zatwierdzenie zapisuje tydzień, a cofnięcie przywraca poprzedni stan', async () => {
      const proposed = data<{ proposalId: string }>(
        await run('propose_week_plan', {
          week_start: PROPOSAL_WEEK,
          slots: [
            {
              day_of_week: 'TUE',
              meal_type: 'DINNER',
              recipe: firstCatalogIndex,
            },
          ],
        }),
      );
      // Propozycja bez `messageId` jest z definicji nieosiągalna (tura padła
      // w połowie). W prawdziwej turze przypina ją runner przy domykaniu —
      // tu robimy to samo ręcznie, bo inaczej nie ma czego zatwierdzać.
      const message = await prisma.agentMessage.create({
        data: {
          conversationId: context.conversationId,
          role: 'ASSISTANT',
          kind: 'PLAN_WEEK',
          text: 'Proponuję taki tydzień.',
        },
      });
      await prisma.agentProposal.update({
        where: { id: proposed.proposalId },
        data: { messageId: message.id },
      });

      const applied = await proposals.apply(
        context.userId,
        proposed.proposalId,
      );
      expect(applied.status).toBe('APPLIED');
      expect(await weekSlots(PROPOSAL_WEEK)).toBe(1);

      // Drugie kliknięcie to ten sam wynik, nie drugi zapis.
      const again = await proposals.apply(context.userId, proposed.proposalId);
      expect(again.status).toBe('APPLIED');
      expect(await weekSlots(PROPOSAL_WEEK)).toBe(1);

      const undone = await proposals.undo(context.userId, proposed.proposalId);
      expect(undone.status).toBe('UNDONE');
      expect(await weekSlots(PROPOSAL_WEEK)).toBe(0);
    });

    it('propozycja dnia NIE rusza reszty tygodnia', async () => {
      // Wtorek stoi w planie od wcześniejszego zapisu; propozycja dotyczy środy.
      const beforeTuesday = data<{ proposalId: string }>(
        await run('propose_day_plan', {
          week_start: PROPOSAL_WEEK,
          day_of_week: 'TUE',
          slots: [{ meal_type: 'DINNER', recipe: firstCatalogIndex }],
        }),
      );
      await attachAndApply(beforeTuesday.proposalId);
      expect(await weekSlots(PROPOSAL_WEEK)).toBe(1);

      const wednesday = data<{
        proposalId: string;
        summary: { meals: number };
      }>(
        await run('propose_day_plan', {
          week_start: PROPOSAL_WEEK,
          day_of_week: 'WED',
          slots: [{ meal_type: 'DINNER', recipe: firstCatalogIndex }],
        }),
      );
      // Karta mówi o JEDNYM dniu, choć zapis obejmuje stan całego tygodnia.
      expect(wednesday.summary.meals).toBe(1);

      const row = await prisma.agentProposal.findUnique({
        where: { id: wednesday.proposalId },
        select: { kind: true, action: true, card: true },
      });
      expect(row?.kind).toBe('PLAN_DAY');
      // Stan docelowy niesie CAŁY tydzień — inaczej zapis skasowałby wtorek.
      const slots = (row?.action as { slots: { dayOfWeek: string }[] }).slots;
      expect(slots.map((slot) => slot.dayOfWeek).sort()).toEqual([
        'TUE',
        'WED',
      ]);

      await attachAndApply(wednesday.proposalId);
      expect(await weekSlots(PROPOSAL_WEEK)).toBe(2);
    });

    it('pytanie z gotowymi odpowiedziami nie tworzy propozycji', async () => {
      const before = collectedCards.length;

      const result = data<{ asked: boolean; options: number }>(
        await run('ask_clarifying_question', {
          question: 'Dla ilu osób mam planować?',
          hint: 'W profilu są cztery osoby.',
          options: ['Dla czterech', 'Dla dwóch'],
        }),
      );

      expect(result).toMatchObject({ asked: true, options: 2 });
      // Karta bez skutków ubocznych idzie kanałem tury, nie przez bazę.
      expect(collectedCards.length).toBe(before + 1);
      const card = collectedCards[collectedCards.length - 1];
      expect(card.kind).toBe('CLARIFY');
      if (card.kind !== 'CLARIFY') throw new Error('nieosiągalne');
      expect(card.actions.map((a) => a.type)).toEqual(['ASK', 'ASK']);
    });

    it('pytanie bez gotowych odpowiedzi wraca jako błąd, nie jako pusta karta', async () => {
      const result = await run('ask_clarifying_question', {
        question: 'A co Ty na to?',
        options: ['Nie wiem'],
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_ERROR' },
      });
    });

    it('podmiana czyta „przed” z PLANU, nie od modelu', async () => {
      // Wtorek ma już kolację z poprzedniego testu — to jest strona „przed”.
      const swap = data<{ proposalId: string }>(
        await run('propose_swap', {
          week_start: PROPOSAL_WEEK,
          day_of_week: 'TUE',
          meal_type: 'DINNER',
          recipe: secondCatalogIndex,
          reason: 'Żeby było szybciej',
        }),
      );

      const row = await prisma.agentProposal.findUnique({
        where: { id: swap.proposalId },
        select: { kind: true, card: true },
      });
      expect(row?.kind).toBe('SWAP');
      const card = row?.card as {
        from: { title: string } | null;
        to: { title: string };
        eyebrow: string;
      };
      expect(card.eyebrow).toBe('Podmiana · wtorek, kolacja');
      // Obie strony pochodzą z bazy: model podał wyłącznie identyfikator.
      expect(card.from?.title).toBeTruthy();
      expect(card.to.title).toBeTruthy();
      expect(card.from?.title).not.toBe(card.to.title);
    });

    it('dania do wyboru dostają nazwy i liczby z bazy, nie z pamięci modelu', async () => {
      const before = collectedCards.length;

      const result = data<{ offered: number }>(
        await run('offer_options', {
          title: 'Trzy szybkie kolacje',
          slot_label: 'Kolacja · wtorek',
          options: [
            { recipe: firstCatalogIndex, tag: 'Najszybsze' },
            { recipe: secondCatalogIndex },
          ],
        }),
      );

      expect(result.offered).toBe(2);
      expect(collectedCards.length).toBe(before + 1);
      const card = collectedCards[collectedCards.length - 1];
      if (card.kind !== 'OPTIONS') throw new Error('oczekiwano karty wyboru');
      expect(card.options).toHaveLength(2);
      expect(card.options[0].title).toBeTruthy();
      expect(card.options[0].prompt).toBe(`Wybieram: ${card.options[0].title}`);
      expect(card.options[0].tag).toBe('Najszybsze');
      // Wybór bez propozycji: dotknięcie wysyła wiadomość, nie zapisuje planu.
      expect(card.actions.every((action) => action.type === 'ASK')).toBe(true);
    });

    it('jedno danie to nie wybór', async () => {
      const result = await run('offer_options', {
        title: 'Jedno',
        options: [{ recipe: firstCatalogIndex }],
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_ERROR' },
      });
    });

    it('podział porcji bierze cele z PROFILI, nie od modelu', async () => {
      const split = data<{ proposalId: string }>(
        await run('propose_household_split', {
          week_start: PROPOSAL_WEEK,
          day_of_week: 'THU',
          meal_type: 'DINNER',
          recipe: firstCatalogIndex,
          portions: [{ user_id: context.userId, note: 'Duża porcja' }],
        }),
      );

      const row = await prisma.agentProposal.findUnique({
        where: { id: split.proposalId },
        select: { kind: true, card: true, action: true },
      });
      expect(row?.kind).toBe('HOUSEHOLD_SPLIT');
      const card = row?.card as {
        portions: { displayName: string; goalLabel: string; note: string }[];
      };
      expect(card.portions).toHaveLength(1);
      // Imię i cel pochodzą z profilu — model podał sam identyfikator i notkę.
      expect(card.portions[0].displayName).toBeTruthy();
      expect(card.portions[0].goalLabel).toContain('kcal');
      expect(card.portions[0].note).toBe('Duża porcja');

      // Zapis jest zwyczajny: jedna pozycja w slocie z listą uczestników.
      const slots = (row?.action as { slots: { participantIds?: string[] }[] })
        .slots;
      expect(
        slots.some((slot) => slot.participantIds?.includes(context.userId)),
      ).toBe(true);
    });

    it('obca osoba w podziale wraca jako błąd, nie jako cudza porcja', async () => {
      const result = await run('propose_household_split', {
        week_start: PROPOSAL_WEEK,
        day_of_week: 'THU',
        meal_type: 'DINNER',
        recipe: firstCatalogIndex,
        portions: [{ user_id: '00000000-0000-4000-8000-0000000000ff' }],
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'PLAN_PARTICIPANT_NOT_IN_HOUSEHOLD' },
      });
    });

    it('luka makro jest POLICZONA z bilansu, nie przepisana od modelu', async () => {
      const before = collectedCards.length;

      const result = data<{ current: number; target: number }>(
        await run('show_macro_gap', {
          week_start: PROPOSAL_WEEK,
          macro: 'KCAL',
          boosters: [{ text: 'Większa porcja obiadu', amount: 300 }],
        }),
      );

      // Cel pochodzi z profilu; model nie podał ani jednej z tych liczb.
      expect(result.target).toBeGreaterThan(0);
      expect(result.current).toBeGreaterThanOrEqual(0);

      expect(collectedCards.length).toBe(before + 1);
      const card = collectedCards[collectedCards.length - 1];
      if (card.kind !== 'MACRO_GAP') throw new Error('oczekiwano karty makro');
      expect(card.unit).toBe('kcal');
      expect(card.current).toBe(result.current);
      expect(card.target).toBe(result.target);
      // Zastosowanie wysyła wiadomość, nie zapisuje trzech podmian naraz.
      expect(card.actions.every((action) => action.type === 'ASK')).toBe(true);
    });

    it('makro bez policzonego celu mówi to wprost, zamiast pokazywać pustą kartę', async () => {
      const result = await run('show_macro_gap', {
        week_start: PROPOSAL_WEEK,
        macro: 'PROTEIN',
        boosters: [{ text: 'Twarożek', amount: 24 }],
      });
      // Konto testowe nie ma policzonych makr — karta bez celu nie ma
      // z czym porównać planu.
      if (!result.ok) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('lista zakupów bierze się z PLANU i nie zmyśla spiżarni', async () => {
      const before = collectedCards.length;

      const result = data<{ remaining: number; checked: number }>(
        await run('show_shopping_list', { week_start: PROPOSAL_WEEK }),
      );

      expect(result.remaining).toBeGreaterThan(0);
      expect(collectedCards.length).toBe(before + 1);
      const card = collectedCards[collectedCards.length - 1];
      if (card.kind !== 'SHOPPING_LIST') throw new Error('oczekiwano listy');
      expect(card.groups.length).toBeGreaterThan(0);
      expect(card.summary.remaining).toBe(result.remaining);
      // Żadna akcja nie zapisuje: lista bierze się z planu, nie z kliknięcia.
      expect(
        card.actions.every((action) => action.type === 'OPEN_SHOPPING'),
      ).toBe(true);
    });

    it('lista zakupów bierze się z PLANU i nie zmyśla spiżarni', async () => {
      const before = collectedCards.length;

      const result = data<{ remaining: number; checked: number }>(
        await run('show_shopping_list', { week_start: PROPOSAL_WEEK }),
      );

      expect(result.remaining).toBeGreaterThan(0);
      expect(collectedCards.length).toBe(before + 1);
      const card = collectedCards[collectedCards.length - 1];
      if (card.kind !== 'SHOPPING_LIST') throw new Error('oczekiwano listy');
      expect(card.groups.length).toBeGreaterThan(0);
      expect(card.summary.remaining).toBe(result.remaining);
      // Żadna akcja nie zapisuje: lista bierze się z planu, nie z kliknięcia.
      expect(
        card.actions.every((action) => action.type === 'OPEN_SHOPPING'),
      ).toBe(true);
    });

    it('naruszenie nie tworzy propozycji — nie ma czego zatwierdzać', async () => {
      const before = await prisma.agentProposal.count({
        where: { conversationId: context.conversationId },
      });

      const result = data<{ proposed: boolean; violations: unknown[] }>(
        await run('propose_week_plan', {
          week_start: PROPOSAL_WEEK,
          slots: [
            {
              day_of_week: 'WED',
              meal_type: 'BREAKFAST',
              recipe: firstCatalogIndex,
            },
          ],
        }),
      );

      expect(result.proposed).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(
        await prisma.agentProposal.count({
          where: { conversationId: context.conversationId },
        }),
      ).toBe(before);
    });
  });

  /**
   * Odchudzony `get_week_plan` — projekcja na granicy asystenta.
   *
   * Jednostkowo sprawdza to `agent-week-plan-projection.spec.ts`; tutaj
   * chodzi o pełną drogę: PRAWDZIWY plan z bazy, przez serwis, przez
   * executor, do kształtu, który zobaczy model.
   */
  describe('get_week_plan dla modelu', () => {
    const SLIM_WEEK = '2026-11-02';

    beforeAll(async () => {
      await run('apply_week_plan', {
        week_start: SLIM_WEEK,
        slots: [
          {
            day_of_week: 'MON',
            meal_type: 'DINNER',
            recipe: firstCatalogIndex,
          },
          {
            day_of_week: 'TUE',
            meal_type: 'DINNER',
            recipe: secondCatalogIndex,
          },
        ],
      });
    });

    it('nie oddaje modelowi ani składów, ani pól technicznych', async () => {
      const result = await run('get_week_plan', { week_start: SLIM_WEEK });
      const serialized = JSON.stringify(result);

      // Pełne `RecipeIngredient` każdego dania były najgrubszą pozycją
      // wyniku — a model nie użył z nich nic, bo składy ma w digeście.
      for (const zabronione of [
        'ingredients',
        'imageUrl',
        'authorId',
        'createdAt',
        'updatedAt',
        'weeklyPlanId',
        'nutritionProtein',
        'normalizedAmount',
        'difficulty',
      ]) {
        expect(serialized).not.toContain(zabronione);
      }
    });

    it('każda pozycja niesie to, czego model potrzebuje do rozumowania', async () => {
      const plan = data<{
        weekStart: string;
        items: {
          dayOfWeek: string;
          mealType: string;
          recipe: string;
          title: string;
          kcalPerServing: number;
          prepTimeMinutes: number;
          plannedServings: number;
        }[];
      }>(await run('get_week_plan', { week_start: SLIM_WEEK }));

      expect(plan.weekStart).toBe(SLIM_WEEK);
      expect(plan.items).toHaveLength(2);
      const monday = plan.items.find((item) => item.dayOfWeek === 'MON');
      expect(monday).toBeDefined();
      expect(monday?.mealType).toBe('DINNER');
      expect(monday?.title.length).toBeGreaterThan(0);
      expect(monday?.kcalPerServing).toBeGreaterThan(0);
      expect(monday?.prepTimeMinutes).toBeGreaterThan(0);
      expect(monday?.plannedServings).toBeGreaterThan(0);
      // Sufit skalowany z limitu 8 KB na pełny tydzień (21 pozycji), który
      // zmierzył `agent-week-plan-projection.spec.ts`.
      expect(JSON.stringify(plan).length).toBeLessThan((8192 / 21) * 2 + 200);
    });

    /**
     * BUDŻET ROZMIARU NA KAŻDE NARZĘDZIE, nie tylko na `get_week_plan`.
     *
     * Odchudzenie jednego wyniku nic nie daje, jeśli sąsiednie narzędzie
     * oddaje ten sam model domenowy tylnymi drzwiami — a dokładnie to się
     * stało: `get_week_plan` schudł do 3,6 KB, podczas gdy `apply_week_plan`
     * dalej zwracał 99,5 KB, bo echo zapisanego planu nikomu nie rzuciło się
     * w oczy. Ten opis mierzy WSZYSTKIE grube ścieżki naraz, więc następne
     * `include: { ingredients: true }` przewróci go, zanim ktoś zapłaci za nie
     * rachunek u dostawcy.
     *
     * Sufity są z pomiaru (7.09.2026) plus zapas na dłuższe tytuły; nie są
     * dobrane pod zielony wynik. Wartości zmierzone: apply 3 689 B,
     * get_week_plan 3 585 B, create/update ~212 B, search (20 wyników) 2 730 B.
     */
    it('żadne narzędzie nie oddaje modelowi modelu domenowego', async () => {
      const rozmiar = (wynik: AgentToolResult) =>
        Buffer.byteLength(
          JSON.stringify(wynik.ok ? wynik.data : wynik.error),
          'utf8',
        );

      const zapis = await run('apply_week_plan', {
        week_start: SLIM_WEEK,
        slots: [
          {
            day_of_week: 'FRI',
            meal_type: 'DINNER',
            recipe: secondCatalogIndex,
          },
        ],
      });
      // Trzy pozycje w tygodniu; sufit skalowany do pełnych 21.
      expect(rozmiar(zapis)).toBeLessThan((8192 / 21) * 3 + 400);
      const zapisJson = JSON.stringify(zapis);
      for (const zabronione of ['ingredients', 'imageUrl', 'authorId']) {
        expect(zapisJson).not.toContain(zabronione);
      }

      const szukaj = await run('search_ingredients', { query: 'a', limit: 20 });
      expect(rozmiar(szukaj)).toBeLessThan(4096);
      // Model wybiera składnik po nazwie i jednostce; kategoria i tagi diety
      // nie biorą udziału w tej decyzji, bo skład przepisu liczy serwer.
      for (const zabronione of ['category', 'dietTags', 'gramsPerPiece']) {
        expect(JSON.stringify(szukaj)).not.toContain(zabronione);
      }

      const bilans = await run('get_week_balance', { week_start: SLIM_WEEK });
      expect(rozmiar(bilans)).toBeLessThan(4096);

      const dom = await run('get_household_context');
      expect(rozmiar(dom)).toBeLessThan(2048);
    });

    it('referencja z planu daje się użyć w kolejnym narzędziu', async () => {
      // Sedno odchudzenia: skoro model dostaje mniej, to co dostaje, MUSI
      // wystarczyć. Bierzemy referencję prosto z wyniku i wkładamy ją do
      // `apply_week_plan` — bez żadnego tłumaczenia po drodze.
      const plan = data<{ items: { recipe: string }[] }>(
        await run('get_week_plan', { week_start: SLIM_WEEK }),
      );
      const ref = plan.items[0].recipe;

      const applied = data<{ applied: boolean; violations: unknown[] }>(
        await run('apply_week_plan', {
          week_start: SLIM_WEEK,
          dry_run: true,
          slots: [{ day_of_week: 'THU', meal_type: 'DINNER', recipe: ref }],
        }),
      );
      expect(applied.violations).toEqual([]);
    });
  });

  /**
   * P0 (audyt etapu 2): konflikt alergenowy domownika BEZ zgody na asystenta.
   *
   * Bramka planu chroni WSZYSTKICH domowników — także tych, których nie ma
   * w `get_household_context`. Do 7.09.2026 znaczyło to, że komunikat bramki
   * („Danie zawiera alergeny domownika: LACTOSE, GLUTEN.") wracał do modelu
   * przez `check_plan_conflicts` nietknięty, bo redakcja rozpoznaje pole
   * `violations`, a to narzędzie nazywało je `conflicts`. Model dostawał dane
   * o zdrowiu osoby, która nigdy nie kliknęła zgody — i przepisywał je do
   * odpowiedzi.
   */
  describe('check_plan_conflicts nie ujawnia alergii domownika bez zgody', () => {
    const CONFLICT_WEEK = '2026-11-09';
    let konfliktowyContext: AgentToolContext;
    let bezZgodyUserId: string;
    let bezZgodyName: string;
    let konfliktowyHouseholdId: string;

    beforeAll(async () => {
      // Bramka zgód WŁĄCZONA — inaczej ten test mierzy zupełnie co innego.
      process.env.AI_CONSENT_REQUIRED = 'true';

      const stamp = `${Date.now()}`;
      const owner = await prisma.user.create({
        data: {
          displayName: `Wlasciciel ${stamp}`,
          email: `konflikt-owner-${stamp}@agent.local`,
          authProvider: 'DEV',
          yearOfBirth: 1994,
          preferences: { create: { allergens: [] } },
        },
        select: { id: true },
      });
      bezZgodyName = `Kubaxyz${stamp}`;
      const bezZgody = await prisma.user.create({
        data: {
          displayName: bezZgodyName,
          email: `konflikt-kuba-${stamp}@agent.local`,
          authProvider: 'DEV',
          yearOfBirth: 1994,
          // DWIE alergie, żeby test nie przeszedł przypadkiem na jednym
          // kodzie, którego akurat nie ma w komunikacie.
          preferences: { create: { allergens: ['lactose', 'gluten'] } },
        },
        select: { id: true },
      });
      createdUserIds.push(owner.id, bezZgody.id);
      bezZgodyUserId = bezZgody.id;

      // TYLKO właściciel klika zgodę. Drugi domownik nie — i to jest sedno.
      await prisma.consentEvent.create({
        data: {
          userId: owner.id,
          kind: 'AI_ASSISTANT',
          action: 'GRANTED',
          documentVersion: LEGAL_DOCUMENT_VERSIONS.AI_ASSISTANT,
        },
      });

      const household = await prisma.household.create({
        data: { name: `Dom konfliktu ${stamp}`, createdById: owner.id },
        select: { id: true },
      });
      konfliktowyHouseholdId = household.id;
      createdHouseholdIds.push(household.id);
      await prisma.membership.createMany({
        data: [
          { userId: owner.id, householdId: household.id, role: 'OWNER' },
          { userId: bezZgody.id, householdId: household.id, role: 'MEMBER' },
        ],
      });

      const conversation = await prisma.agentConversation.create({
        data: { userId: owner.id, householdId: household.id },
        select: { id: true },
      });
      konfliktowyContext = {
        ...context,
        userId: owner.id,
        householdId: household.id,
        conversationId: conversation.id,
      };

      // Danie z laktozą I glutenem na kolację: konflikt dotyczy domownika
      // bez zgody, nie pytającego.
      const recipes = await loadDigestRecipes(prisma, CATALOG_HOUSEHOLD);
      const konfliktowy = recipes.find(
        (recipe) =>
          recipe.allergens.includes('lactose') &&
          recipe.allergens.includes('gluten') &&
          (recipe.suitableMealTypes.length > 0
            ? recipe.suitableMealTypes
            : [recipe.mealType]
          ).includes('DINNER'),
      );
      if (!konfliktowy) throw new Error('katalog nie ma dania lactose+gluten');

      const plan = await prisma.weeklyPlan.create({
        data: {
          householdId: household.id,
          weekStart: new Date(`${CONFLICT_WEEK}T00:00:00.000Z`),
        },
        select: { id: true },
      });
      await prisma.planItem.create({
        data: {
          weeklyPlanId: plan.id,
          recipeId: konfliktowy.id,
          dayOfWeek: 'WED',
          mealType: 'DINNER',
          plannedServings: 2,
          participants: { create: [{ userId: bezZgody.id }] },
        },
      });
    });

    afterAll(() => {
      process.env.AI_CONSENT_REQUIRED = 'false';
    });

    it('domownik bez zgody NIE jest widoczny w get_household_context', async () => {
      // Warunek wstępny: gdyby był, cały ten opis niczego by nie dowodził.
      const members = data<{ userId: string }[]>(
        await executor.execute('get_household_context', {}, konfliktowyContext),
      );
      expect(members.map((member) => member.userId)).not.toContain(
        bezZgodyUserId,
      );
    });

    it('bramka WIDZI konflikt — ochrona nie osłabła', async () => {
      const result = data<{
        checkedSlots: number;
        violations: { code: string }[];
      }>(
        await executor.execute(
          'check_plan_conflicts',
          { week_start: CONFLICT_WEEK },
          konfliktowyContext,
        ),
      );
      expect(result.checkedSlots).toBe(1);
      expect(result.violations.map((entry) => entry.code)).toContain(
        'RECIPE_ALLERGEN_CONFLICT',
      );
    });

    it('…ale model NIE dostaje kodów alergenów ani danych tej osoby', async () => {
      const result = await executor.execute(
        'check_plan_conflicts',
        { week_start: CONFLICT_WEEK },
        konfliktowyContext,
      );
      const serialized = JSON.stringify(result);

      for (const kod of [
        'LACTOSE',
        'GLUTEN',
        'lactose',
        'gluten',
        'milk',
        'eggs',
      ]) {
        expect(serialized).not.toContain(kod);
      }
      expect(serialized).not.toContain(bezZgodyUserId);
      expect(serialized).not.toContain(bezZgodyName);
      // Kod naruszenia ZOSTAJE: model ma wiedzieć, że musi zmienić danie.
      expect(serialized).toContain('RECIPE_ALLERGEN_CONFLICT');
    });

    it('get_week_plan też nie wynosi tożsamości osoby bez zgody', async () => {
      const plan = await executor.execute(
        'get_week_plan',
        { week_start: CONFLICT_WEEK },
        konfliktowyContext,
      );
      const serialized = JSON.stringify(plan);
      expect(serialized).not.toContain(bezZgodyUserId);
      expect(serialized).not.toContain(bezZgodyName);
      // …za to LICZBA jedzących zostaje, bo bez niej nie ma jak policzyć porcji.
      expect(serialized).toContain('othersCount');
    });

    it('redakcja dla apply_week_plan / propose_* działa jak dotąd', async () => {
      // Ta sama funkcja redagująca obsługiwała `violations` od początku;
      // poprawka `conflicts` → `violations` nie miała prawa jej ruszyć.
      const rejected = data<{
        applied: boolean;
        violations: { code: string; message: string }[];
      }>(
        await executor.execute(
          'apply_week_plan',
          {
            week_start: CONFLICT_WEEK,
            dry_run: true,
            slots: [
              {
                day_of_week: 'THU',
                meal_type: 'DINNER',
                recipe: firstCatalogIndex,
                participant_user_ids: [bezZgodyUserId],
              },
            ],
          },
          konfliktowyContext,
        ),
      );

      const konflikt = rejected.violations.find(
        (entry) => entry.code === 'RECIPE_ALLERGEN_CONFLICT',
      );
      expect(konflikt).toBeDefined();
      expect(konflikt?.message).not.toMatch(/lactose|gluten/i);
      expect(konflikt?.message).toContain('wybierz inne danie');
      expect(konfliktowyHouseholdId).toBeDefined();
    });
  });
});
