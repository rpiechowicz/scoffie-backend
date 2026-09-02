import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { AddressInfo } from 'net';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Operacja wsadowa na tydzień (`weeklyPlans:applyWeekPlan`) na żywej bazie.
 *
 * Dotąd plan dało się zmieniać wyłącznie per slot — 21 posiłków to 21–42
 * wywołania, a błąd przy szesnastym zostawiał pół tygodnia. Ta suita pilnuje
 * trzech rzeczy, których testy na mockach nie udowodnią: że różnica względem
 * bazy liczy się poprawnie (nie „skasuj i zapisz od nowa"), że przy
 * naruszeniach NIC nie wchodzi, i że przeplanowanie NIE niszczy archiwów list
 * zakupów — bo to był powód, dla którego to jest diff, a nie `clearWeekPlan`.
 */
type WsEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; message?: string; code: string };

type Session = { accessToken: string; user: { id: string } };

type Violation = { index: number; code: string; recipeId: string };

type ApplyResult = {
  applied: boolean;
  dryRun: boolean;
  violations: Violation[];
  changes: { created: number; updated: number; deleted: number };
  plan: { items: { recipe: { id: string } }[] } | null;
};

type WeekPlan = { items: { recipe: { id: string } }[] };

const WEEK_START = '2026-08-31';
const OTHER_WEEK = '2026-09-07';

describe('applyWeekPlan E2E', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let baseUrl: string;

  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];
  const sockets: Socket[] = [];
  const originalMode = process.env.WS_AUTH_MODE;

  let householdId: string;
  let socket: Socket;
  let dinnerA: string;
  let dinnerB: string;
  let breakfast: string;
  /** Przepis, który NIE nadaje się na śniadanie — do testu bramki slotu. */
  let notBreakfast: string;

  const devLogin = async (label: string): Promise<Session> => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `${label} ${stamp}`,
        email: `${label.toLowerCase()}-${stamp}@apply.local`,
      })
      .expect(201);
    const session = res.body as Session;
    createdUserIds.push(session.user.id);
    return session;
  };

  const connect = (token: string): Socket => {
    const client = io(baseUrl, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { token },
    });
    sockets.push(client);
    return client;
  };

  const waitConnect = (client: Socket): Promise<void> =>
    new Promise((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('connect_error', (err: Error) => reject(err));
    });

  const ack = <T>(
    client: Socket,
    event: string,
    payload: unknown,
  ): Promise<WsEnvelope<T>> =>
    new Promise((resolve, reject) => {
      client
        .timeout(9000)
        .emit(event, payload, (err: Error | null, response: WsEnvelope<T>) => {
          if (err) reject(err);
          else resolve(response);
        });
    });

  const okData = <T>(envelope: WsEnvelope<T>): T => {
    if (!envelope.ok) throw new Error(`oczekiwano sukcesu: ${envelope.code}`);
    return envelope.data;
  };

  const apply = async (
    slots: Record<string, unknown>[],
    opts: { dryRun?: boolean; weekStart?: string } = {},
  ): Promise<ApplyResult> =>
    okData(
      await ack<ApplyResult>(socket, 'weeklyPlans:applyWeekPlan', {
        householdId,
        weekStart: opts.weekStart ?? WEEK_START,
        data: { slots, ...(opts.dryRun ? { dryRun: true } : {}) },
      }),
    );

  const readWeek = async (weekStart = WEEK_START): Promise<WeekPlan> =>
    okData(
      await ack<WeekPlan>(socket, 'weeklyPlans:getByWeek', {
        householdId,
        weekStart,
      }),
    );

  const slot = (
    dayOfWeek: string,
    mealType: string,
    recipeId: string,
    extra: Record<string, unknown> = {},
  ) => ({ dayOfWeek, mealType, recipeId, ...extra });

  beforeAll(async () => {
    process.env.WS_AUTH_MODE = 'strict';
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);

    const suitableFor = async (
      mealType: 'DINNER' | 'BREAKFAST',
      take: number,
    ) =>
      prisma.recipe.findMany({
        where: {
          isCatalog: true,
          isActive: true,
          OR: [
            { suitableMealTypes: { has: mealType } },
            { mealType, suitableMealTypes: { isEmpty: true } },
          ],
        },
        select: { id: true },
        take,
      });

    const dinners = await suitableFor('DINNER', 2);
    const breakfasts = await suitableFor('BREAKFAST', 1);
    const unsuitable = await prisma.recipe.findFirst({
      where: {
        isCatalog: true,
        isActive: true,
        NOT: {
          OR: [
            { suitableMealTypes: { has: 'BREAKFAST' } },
            { mealType: 'BREAKFAST', suitableMealTypes: { isEmpty: true } },
          ],
        },
      },
      select: { id: true },
    });
    if (dinners.length < 2 || breakfasts.length < 1 || !unsuitable) {
      throw new Error('katalog dev nie ma przepisów potrzebnych do tej suity');
    }
    dinnerA = dinners[0].id;
    dinnerB = dinners[1].id;
    breakfast = breakfasts[0].id;
    notBreakfast = unsuitable.id;

    const session = await devLogin('Planista');
    socket = connect(session.accessToken);
    await waitConnect(socket);
    householdId = okData(
      await ack<{ id: string }>(socket, 'households:create', {
        data: { name: `Dom planisty ${Date.now()}` },
      }),
    ).id;
    createdHouseholdIds.push(householdId);
  });

  afterAll(async () => {
    if (originalMode === undefined) delete process.env.WS_AUTH_MODE;
    else process.env.WS_AUTH_MODE = originalMode;
    for (const client of sockets.splice(0)) client.disconnect();
    if (createdHouseholdIds.length) {
      await prisma.household.deleteMany({
        where: { id: { in: createdHouseholdIds } },
      });
    }
    if (createdUserIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  describe('dry-run', () => {
    it('liczy zmiany, ale NIE zapisuje niczego', async () => {
      const result = await apply(
        [slot('MON', 'DINNER', dinnerA), slot('TUE', 'DINNER', dinnerB)],
        { dryRun: true },
      );

      expect(result).toMatchObject({
        applied: false,
        dryRun: true,
        violations: [],
        changes: { created: 2, updated: 0, deleted: 0 },
      });
      expect((await readWeek()).items).toHaveLength(0);
    });
  });

  describe('zapis', () => {
    it('zakłada cały tydzień jednym wywołaniem', async () => {
      const result = await apply([
        slot('MON', 'DINNER', dinnerA),
        slot('TUE', 'DINNER', dinnerB),
        slot('WED', 'BREAKFAST', breakfast),
      ]);

      expect(result.applied).toBe(true);
      expect(result.changes).toEqual({ created: 3, updated: 0, deleted: 0 });
      expect(result.plan?.items).toHaveLength(3);
    });

    it('ponowne wysłanie tego samego tygodnia nic nie rusza', async () => {
      const result = await apply([
        slot('MON', 'DINNER', dinnerA),
        slot('TUE', 'DINNER', dinnerB),
        slot('WED', 'BREAKFAST', breakfast),
      ]);

      // Niezmieniony slot nie jest zapisywany — inaczej „przeplanuj" dotykałoby
      // wszystkiego i psuło każdy przyszły audyt zmian.
      expect(result.changes).toEqual({ created: 0, updated: 0, deleted: 0 });
    });

    it('pominięty slot znika, nowy dochodzi — to jest stan docelowy, nie łatka', async () => {
      const result = await apply([
        slot('MON', 'DINNER', dinnerA),
        slot('THU', 'DINNER', dinnerB),
      ]);

      expect(result.changes).toEqual({ created: 1, updated: 0, deleted: 2 });
      const ids = (await readWeek()).items.map((i) => i.recipe.id);
      expect(ids).toHaveLength(2);
      expect(ids).toContain(dinnerA);
    });

    it('zmiana samych porcji liczy się jako update, nie create', async () => {
      const result = await apply([
        slot('MON', 'DINNER', dinnerA, { plannedServings: 6 }),
        slot('THU', 'DINNER', dinnerB),
      ]);

      expect(result.changes).toEqual({ created: 0, updated: 1, deleted: 0 });
    });

    it('pusta lista czyści tydzień', async () => {
      const result = await apply([]);
      expect(result.changes.deleted).toBe(2);
      expect((await readWeek()).items).toHaveLength(0);
    });
  });

  describe('naruszenia', () => {
    beforeEach(async () => {
      await apply([slot('MON', 'DINNER', dinnerA)]);
    });

    const expectUntouched = async () => {
      const items = (await readWeek()).items;
      expect(items).toHaveLength(1);
      expect(items[0].recipe.id).toBe(dinnerA);
    };

    it('nieznany przepis → RECIPE_NOT_FOUND i plan bez zmian', async () => {
      const result = await apply([
        slot('MON', 'DINNER', dinnerA),
        slot('TUE', 'DINNER', '11111111-2222-4333-8444-555555555555'),
      ]);

      expect(result.applied).toBe(false);
      expect(result.violations).toEqual([
        expect.objectContaining({ index: 1, code: 'RECIPE_NOT_FOUND' }),
      ]);
      await expectUntouched();
    });

    it('danie nie do tego posiłku → RECIPE_NOT_SUITABLE_FOR_SLOT', async () => {
      const result = await apply([slot('TUE', 'BREAKFAST', notBreakfast)]);

      expect(result.violations).toEqual([
        expect.objectContaining({ code: 'RECIPE_NOT_SUITABLE_FOR_SLOT' }),
      ]);
      await expectUntouched();
    });

    it('ten sam przepis dwa razy w slocie → PLAN_SLOT_DUPLICATE', async () => {
      const result = await apply([
        slot('MON', 'DINNER', dinnerA),
        slot('MON', 'DINNER', dinnerA),
      ]);

      expect(result.violations).toEqual([
        expect.objectContaining({ index: 1, code: 'PLAN_SLOT_DUPLICATE' }),
      ]);
      await expectUntouched();
    });

    it('obcy domownik w audytorium → PLAN_PARTICIPANT_NOT_IN_HOUSEHOLD', async () => {
      const result = await apply([
        slot('MON', 'DINNER', dinnerA, {
          participantIds: ['99999999-9999-4999-8999-999999999999'],
        }),
      ]);

      expect(result.violations).toEqual([
        expect.objectContaining({
          code: 'PLAN_PARTICIPANT_NOT_IN_HOUSEHOLD',
        }),
      ]);
      await expectUntouched();
    });

    it('zbiera WSZYSTKIE naruszenia naraz, nie pierwsze z brzegu', async () => {
      const result = await apply([
        slot('TUE', 'DINNER', '11111111-2222-4333-8444-555555555555'),
        slot('WED', 'BREAKFAST', notBreakfast),
      ]);

      // O to chodzi w dry-runie: asystent poprawia cały tydzień w jednej
      // rundzie, zamiast dowiadywać się o kolejnym błędzie po każdej próbie.
      expect(result.violations.map((v) => v.code)).toEqual([
        'RECIPE_NOT_FOUND',
        'RECIPE_NOT_SUITABLE_FOR_SLOT',
      ]);
      await expectUntouched();
    });
  });

  describe('archiwa list zakupów', () => {
    it('przeplanowanie tygodnia NIE kasuje archiwum (to był powód dla diffa)', async () => {
      const archive = await prisma.shoppingListArchive.create({
        data: {
          householdId,
          weekStart: new Date(`${OTHER_WEEK}T00:00:00.000Z`),
          weekLabel: 'testowy tydzień',
          revision: 1,
          signature: `sig-${Date.now()}`,
        },
        select: { id: true },
      });

      await apply([slot('MON', 'DINNER', dinnerA)], { weekStart: OTHER_WEEK });
      await apply([slot('TUE', 'DINNER', dinnerB)], { weekStart: OTHER_WEEK });

      // `clearWeekPlan` kasuje `shoppingListArchive*` dla tygodnia; gdyby
      // „przeplanuj" szło przez clear + zapis, historia zakupów znikałaby
      // przy każdej zmianie planu.
      await expect(
        prisma.shoppingListArchive.findUnique({ where: { id: archive.id } }),
      ).resolves.not.toBeNull();
    });
  });

  // Wykluczenie to nie alergia: „nie jem pieczarek" nie ma nic wspólnego ze
  // zdrowiem, ale skutek dla planu jest ten sam — takiego dania nie wolno
  // wstawić. Do Fazy 2 ta informacja żyła wyłącznie w rozmowie z asystentem
  // i ginęła razem z turą.
  describe('bramka wykluczonych składników', () => {
    let danie: string;
    let skladnik: string;
    let ownerId: string;
    let inny: string;

    beforeAll(async () => {
      const zPieczarka = await prisma.recipe.findFirst({
        where: {
          isCatalog: true,
          isActive: true,
          OR: [
            { suitableMealTypes: { has: 'DINNER' } },
            { mealType: 'DINNER', suitableMealTypes: { isEmpty: true } },
          ],
          ingredients: { some: {} },
        },
        select: { id: true, ingredients: { select: { ingredientId: true } } },
      });
      if (!zPieczarka)
        throw new Error('katalog dev nie ma kolacji ze składnikami');
      danie = zPieczarka.id;
      skladnik = zPieczarka.ingredients[0].ingredientId;

      const membership = await prisma.membership.findFirst({
        where: { householdId },
        select: { userId: true },
      });
      ownerId = membership!.userId;
      await prisma.userPreference.upsert({
        where: { userId: ownerId },
        create: { userId: ownerId, excludedIngredientIds: [skladnik] },
        update: { excludedIngredientIds: [skladnik] },
      });

      const other = await prisma.user.create({
        data: {
          displayName: `Bez wykluczeń ${Date.now()}`,
          email: `noexcl-${Date.now()}@apply.local`,
          authProvider: 'DEV',
        },
        select: { id: true },
      });
      inny = other.id;
      createdUserIds.push(inny);
      await prisma.membership.create({
        data: { userId: inny, householdId, role: 'MEMBER' },
      });
    });

    afterAll(async () => {
      await prisma.userPreference.updateMany({
        where: { userId: ownerId },
        data: { excludedIngredientIds: [] },
      });
      await prisma.membership.deleteMany({
        where: { userId: inny, householdId },
      });
    });

    it('ręczne wstawienie z telefonu ma tę samą bramkę wykluczeń co zapis tygodnia', async () => {
      // Do 3.09 tylko `applyWeekPlan` sprawdzał wykluczenia — asystent nie
      // mógł wstawić dania z pieczarkami, a ręka z telefonu mogła.
      const refused = await ack<{ id: string }>(
        socket,
        'weeklyPlans:upsertWeekSlot',
        {
          householdId,
          weekStart: '2026-11-02',
          data: { dayOfWeek: 'WED', mealType: 'DINNER', recipeId: danie },
        },
      );
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.code).toBe('RECIPE_EXCLUDED_INGREDIENT');

      // Ta sama reguła audytorium: dla domownika bez wykluczenia wchodzi.
      const accepted = await ack<{ id: string }>(
        socket,
        'weeklyPlans:upsertWeekSlot',
        {
          householdId,
          weekStart: '2026-11-02',
          data: {
            dayOfWeek: 'WED',
            mealType: 'DINNER',
            recipeId: danie,
            participantIds: [inny],
          },
        },
      );
      expect(accepted.ok).toBe(true);
      await prisma.weeklyPlan.deleteMany({
        where: { householdId, weekStart: new Date('2026-11-02T00:00:00.000Z') },
      });
    });

    it('danie z wykluczonym składnikiem nie wchodzi do wspólnego posiłku', async () => {
      const result = await apply([slot('TUE', 'DINNER', danie)], {
        dryRun: true,
      });

      expect(result.applied).toBe(false);
      expect(result.violations[0]).toMatchObject({
        code: 'RECIPE_EXCLUDED_INGREDIENT',
        recipeId: danie,
      });
      // Osobny kod, nie RECIPE_ALLERGEN_CONFLICT: komunikat o „alergenach"
      // przy zwykłej niechęci byłby po prostu nieprawdą, a użytkownik go czyta.
      expect(result.violations[0].code).not.toBe('RECIPE_ALLERGEN_CONFLICT');
    });

    it('to samo danie przechodzi, gdy je ktoś bez tego wykluczenia', async () => {
      const result = await apply(
        [slot('TUE', 'DINNER', danie, { participantIds: [inny] })],
        { dryRun: true },
      );

      // Tak samo jak przy alergenach: liczy się AUDYTORIUM posiłku, nie skład
      // całego domu — jedno „nie jem pieczarek" nie wykreśla dania wszystkim.
      expect(result.violations).toEqual([]);
    });
  });

  describe('bramka alergenowa', () => {
    let alergenRecipe: string;
    let alergenName: string;
    let ownerId: string;

    beforeAll(async () => {
      const withAllergen = await prisma.recipe.findFirst({
        where: {
          isCatalog: true,
          isActive: true,
          allergens: { has: 'lactose' },
          OR: [
            { suitableMealTypes: { has: 'DINNER' } },
            { mealType: 'DINNER', suitableMealTypes: { isEmpty: true } },
          ],
        },
        select: { id: true, title: true },
      });
      if (!withAllergen)
        throw new Error('katalog dev nie ma kolacji z laktozą');
      alergenRecipe = withAllergen.id;
      alergenName = withAllergen.title;

      const membership = await prisma.membership.findFirst({
        where: { householdId },
        select: { userId: true },
      });
      ownerId = membership!.userId;
      await prisma.userPreference.upsert({
        where: { userId: ownerId },
        create: { userId: ownerId, allergens: ['lactose'] },
        update: { allergens: ['lactose'] },
      });
    });

    afterAll(async () => {
      await prisma.userPreference.updateMany({
        where: { userId: ownerId },
        data: { allergens: [] },
      });
    });

    it('danie z alergenem domownika nie wchodzi do wspólnego posiłku', async () => {
      const result = await apply([slot('MON', 'DINNER', alergenRecipe)], {
        dryRun: true,
      });

      // To jest twarda bramka SERWERA, nie instrukcja dla modelu: lista
      // składników w digeście jest przycięta do pięciu najcięższych, więc
      // 20 g masła w daniu rybnym jest dla modelu niewidoczne.
      expect(result.applied).toBe(false);
      expect(result.violations[0]).toMatchObject({
        code: 'RECIPE_ALLERGEN_CONFLICT',
      });
      expect(result.violations[0].recipeId).toBe(alergenRecipe);
    });

    it('to samo danie przechodzi, gdy je ktoś bez tej alergii', async () => {
      const other = await prisma.user.create({
        data: {
          displayName: `Bez alergii ${Date.now()}`,
          email: `noallergy-${Date.now()}@apply.local`,
          authProvider: 'DEV',
        },
        select: { id: true },
      });
      createdUserIds.push(other.id);
      await prisma.membership.create({
        data: { userId: other.id, householdId, role: 'MEMBER' },
      });

      const result = await apply(
        [slot('MON', 'DINNER', alergenRecipe, { participantIds: [other.id] })],
        { dryRun: true },
      );

      // Bramka liczy AUDYTORIUM, nie sam skład domu — inaczej jedna alergia
      // wykreślałaby danie wszystkim, także tym, którzy je jedzą bez problemu.
      expect(result.violations).toEqual([]);
      expect(alergenName.length).toBeGreaterThan(0);

      await prisma.membership.deleteMany({
        where: { userId: other.id, householdId },
      });
    });
  });

  describe('broadcast', () => {
    it('cały tydzień to JEDEN weekChanged, nie jeden na slot', async () => {
      // `broadcastToHousehold` nadaje do pokoju gospodarstwa, a socket
      // wołającego też w nim siedzi — więc liczymy na nim.
      let received = 0;
      const count = () => {
        received += 1;
      };
      socket.on('weeklyPlans:weekChanged', count);

      await apply([
        slot('MON', 'DINNER', dinnerA),
        slot('TUE', 'DINNER', dinnerB),
        slot('WED', 'BREAKFAST', breakfast),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Dawniej ten sam tydzień to było 21 wywołań i 21 broadcastów.
      expect(received).toBe(1);
      socket.off('weeklyPlans:weekChanged', count);
    });

    it('dry-run nie nadaje nic — nie ma czego odświeżać', async () => {
      let received = 0;
      const count = () => {
        received += 1;
      };
      socket.on('weeklyPlans:weekChanged', count);

      await apply([slot('FRI', 'DINNER', dinnerA)], { dryRun: true });
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(received).toBe(0);
      socket.off('weeklyPlans:weekChanged', count);
    });
  });
});
