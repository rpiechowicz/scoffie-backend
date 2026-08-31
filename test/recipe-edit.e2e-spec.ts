import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { AddressInfo } from 'net';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Pętla „zaproponuj → popraw → zapisz" na żywej bazie: kroki przygotowania,
 * `recipes:update` i `recipes:delete`.
 *
 * Do Fazy 1 istniało wyłącznie tworzenie — asystent potrafił zaproponować
 * danie, ale nie umiał go poprawić po uwadze użytkownika ani wycofać. Ta suita
 * pilnuje trzech rzeczy, których mocki nie pokażą: że zmiana składników
 * NAPRAWDĘ przelicza makra i tagi, że katalogu nie da się edytować, i że
 * wycofany przepis znika z listy oraz z możliwych wyborów do planu.
 */
type WsEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: string };

type Recipe = {
  id: string;
  title: string;
  servings: number;
  nutritionKcal: number;
  dietTags: string[];
  isActive: boolean;
  sourceInstructions: { stepNumber: number; text: string }[] | null;
};

const WEEK_START = '2026-09-14';

describe('Edycja przepisów E2E', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let baseUrl: string;

  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];
  const createdRecipeIds: string[] = [];
  const sockets: Socket[] = [];
  const originalMode = process.env.WS_AUTH_MODE;

  let socket: Socket;
  let householdId: string;
  let catalogRecipeId: string;
  let meatIngredientId: string;
  let vegIngredientId: string;

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

  const devLogin = async (label: string) => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `${label} ${stamp}`,
        email: `${label.toLowerCase()}-${stamp}@edit.local`,
      })
      .expect(201);
    const session = res.body as { accessToken: string; user: { id: string } };
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
      client.once('connect_error', reject);
    });

  const createRecipe = async (
    overrides: Record<string, unknown> = {},
  ): Promise<Recipe> => {
    const recipe = okData(
      await ack<Recipe>(socket, 'recipes:create', {
        data: {
          householdId,
          title: `Danie testowe ${Date.now()}-${Math.random()}`.slice(0, 60),
          description: 'Przepis na potrzeby testu.',
          mealType: 'DINNER',
          difficulty: 'EASY',
          prepTimeMinutes: 20,
          servings: 2,
          ingredients: [
            { ingredientId: meatIngredientId, amount: 200, unit: 'g' },
          ],
          ...overrides,
        },
      }),
    );
    createdRecipeIds.push(recipe.id);
    return recipe;
  };

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

    const catalog = await prisma.recipe.findFirst({
      where: { isCatalog: true, isActive: true },
      select: { id: true },
    });
    const meat = await prisma.ingredient.findFirst({
      where: {
        isActive: true,
        nutritionKcalPer100: { not: null },
        dietTags: { has: 'MEAT' },
      },
      select: { id: true },
    });
    const veg = await prisma.ingredient.findFirst({
      where: {
        isActive: true,
        nutritionKcalPer100: { not: null },
        category: 'Warzywa',
        NOT: { dietTags: { has: 'MEAT' } },
      },
      select: { id: true },
    });
    if (!catalog || !meat || !veg) {
      throw new Error('baza dev nie ma danych potrzebnych do tej suity');
    }
    catalogRecipeId = catalog.id;
    meatIngredientId = meat.id;
    vegIngredientId = veg.id;

    const session = await devLogin('Kucharz');
    socket = connect(session.accessToken);
    await waitConnect(socket);
    householdId = okData(
      await ack<{ id: string }>(socket, 'households:create', {
        data: { name: `Dom kucharza ${Date.now()}` },
      }),
    ).id;
    createdHouseholdIds.push(householdId);
  });

  afterAll(async () => {
    if (originalMode === undefined) delete process.env.WS_AUTH_MODE;
    else process.env.WS_AUTH_MODE = originalMode;
    for (const client of sockets.splice(0)) client.disconnect();
    if (createdRecipeIds.length) {
      await prisma.recipe.deleteMany({
        where: { id: { in: createdRecipeIds } },
      });
    }
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

  describe('kroki przygotowania', () => {
    it('zapisują się przy tworzeniu — do Fazy 1 dało się je wgrać tylko importem', async () => {
      const recipe = await createRecipe({
        steps: [
          { text: 'Podsmaż cebulę.' },
          { text: 'Dodaj mięso.' },
          { text: 'Duś 15 minut.' },
        ],
      });

      expect(recipe.sourceInstructions).toEqual([
        { stepNumber: 1, text: 'Podsmaż cebulę.' },
        { stepNumber: 2, text: 'Dodaj mięso.' },
        { stepNumber: 3, text: 'Duś 15 minut.' },
      ]);
    });

    it('numery od klienta ustalają kolejność, ale zapisujemy własne', async () => {
      const recipe = await createRecipe({
        steps: [
          { stepNumber: 9, text: 'Podawaj.' },
          { stepNumber: 1, text: 'Ugotuj.' },
        ],
      });
      expect(recipe.sourceInstructions).toEqual([
        { stepNumber: 1, text: 'Ugotuj.' },
        { stepNumber: 2, text: 'Podawaj.' },
      ]);
    });
  });

  describe('recipes:update', () => {
    it('rusza tylko przysłane pole — reszta zostaje', async () => {
      const recipe = await createRecipe();
      const updated = okData(
        await ack<Recipe>(socket, 'recipes:update', {
          id: recipe.id,
          data: { householdId, title: 'Nowy tytuł dania' },
        }),
      );

      expect(updated.title).toBe('Nowy tytuł dania');
      expect(updated.servings).toBe(recipe.servings);
      expect(updated.nutritionKcal).toBe(recipe.nutritionKcal);
    });

    it('zmiana składników przelicza makra i tagi diet', async () => {
      const recipe = await createRecipe();
      expect(recipe.dietTags).toContain('MEAT');

      const updated = okData(
        await ack<Recipe>(socket, 'recipes:update', {
          id: recipe.id,
          data: {
            householdId,
            ingredients: [
              { ingredientId: vegIngredientId, amount: 300, unit: 'g' },
            ],
          },
        }),
      );

      // Bez przeliczenia przepis zostałby oznaczony jako mięsny mimo warzyw —
      // i walidator diet przepuściłby go weganinowi.
      expect(updated.dietTags).not.toContain('MEAT');
      expect(updated.nutritionKcal).not.toBe(recipe.nutritionKcal);
    });

    it('kroki przysłane przy edycji zastępują poprzednie', async () => {
      const recipe = await createRecipe({ steps: [{ text: 'Stary krok.' }] });
      const updated = okData(
        await ack<Recipe>(socket, 'recipes:update', {
          id: recipe.id,
          data: { householdId, steps: [{ text: 'Zupełnie nowy krok.' }] },
        }),
      );
      expect(updated.sourceInstructions).toEqual([
        { stepNumber: 1, text: 'Zupełnie nowy krok.' },
      ]);
    });

    it('przepisu z KATALOGU nie da się edytować', async () => {
      const response = await ack(socket, 'recipes:update', {
        id: catalogRecipeId,
        data: { householdId, title: 'Podmieniony katalog' },
      });
      // Kod mówi asystentowi, co zrobić zamiast ponawiać: własną kopię.
      expect(response).toMatchObject({
        ok: false,
        code: 'RECIPE_NOT_EDITABLE',
      });
    });

    it('cudzy przepis prywatny to 404, nie 403', async () => {
      const other = await devLogin('Obcy');
      const otherSocket = connect(other.accessToken);
      await waitConnect(otherSocket);
      const otherHousehold = okData(
        await ack<{ id: string }>(otherSocket, 'households:create', {
          data: { name: `Cudzy dom ${Date.now()}` },
        }),
      ).id;
      createdHouseholdIds.push(otherHousehold);

      const mine = await createRecipe();
      const response = await ack(otherSocket, 'recipes:update', {
        id: mine.id,
        data: { householdId: otherHousehold, title: 'Podmiana' },
      });
      expect(response).toMatchObject({ ok: false, code: 'RECIPE_NOT_FOUND' });
    });
  });

  describe('recipes:delete', () => {
    it('wycofuje przepis zamiast go kasować', async () => {
      const recipe = await createRecipe();
      const result = okData(
        await ack<{ id: string; isActive: boolean }>(socket, 'recipes:delete', {
          id: recipe.id,
          householdId,
        }),
      );
      expect(result).toEqual({ id: recipe.id, isActive: false });

      // Wiersz zostaje — historia i ewentualne odwołania nie znikają.
      const row = await prisma.recipe.findUnique({
        where: { id: recipe.id },
        select: { isActive: true },
      });
      expect(row?.isActive).toBe(false);
    });

    it('wycofany przepis znika z odczytu po id', async () => {
      const recipe = await createRecipe();
      await ack(socket, 'recipes:delete', { id: recipe.id, householdId });

      const response = await ack(socket, 'recipes:findById', {
        id: recipe.id,
        householdId,
      });
      expect(response).toMatchObject({ ok: false, code: 'RECIPE_NOT_FOUND' });
    });

    it('wycofanego przepisu nie da się wstawić do planu', async () => {
      const recipe = await createRecipe();
      await ack(socket, 'recipes:delete', { id: recipe.id, householdId });

      const response = await ack(socket, 'weeklyPlans:upsertWeekSlot', {
        householdId,
        weekStart: WEEK_START,
        data: {
          dayOfWeek: 'MON',
          mealType: 'DINNER',
          recipeId: recipe.id,
          participantIds: [],
          plannedServings: 2,
        },
      });
      expect(response).toMatchObject({ ok: false, code: 'RECIPE_NOT_FOUND' });
    });

    it('przepis stojący w planie odmawia wycofania', async () => {
      const recipe = await createRecipe();
      okData(
        await ack(socket, 'weeklyPlans:upsertWeekSlot', {
          householdId,
          weekStart: WEEK_START,
          data: {
            dayOfWeek: 'TUE',
            mealType: 'DINNER',
            recipeId: recipe.id,
            participantIds: [],
            plannedServings: 2,
          },
        }),
      );

      const response = await ack(socket, 'recipes:delete', {
        id: recipe.id,
        householdId,
      });
      // Dziura w planie i w liście zakupów jest gorsza niż przepis za dużo.
      expect(response).toMatchObject({ ok: false, code: 'RECIPE_IN_USE' });
    });

    it('katalogu nie da się wycofać', async () => {
      const response = await ack(socket, 'recipes:delete', {
        id: catalogRecipeId,
        householdId,
      });
      expect(response).toMatchObject({
        ok: false,
        code: 'RECIPE_NOT_EDITABLE',
      });
    });
  });
});
