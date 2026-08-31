import { Test, TestingModule } from '@nestjs/testing';
import { RecipesGateway } from './recipes.gateway';
import { RecipesService } from './recipes.service';
import { WsTelemetryService } from '../common/ws-telemetry.service';

// Gateway ma na własność trzy rzeczy: skąd bierze tożsamość (socket z tokenem
// ignoruje payload.userId, socket legacy ufa mu jak dawniej, anonim dostaje
// UNAUTHORIZED w acku), kopertę zdarzenia (brak `data`, nie-UUID → ack
// VALIDATION_ERROR, serwis nietknięty) i dokąd idzie `recipes:favoritesChanged`
// (pokój domu + legacy, nigdy do całego serwera). Reszta to przekazanie do serwisu.

const HH = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const RECIPE = '7adf5ec0-e3e5-4b28-8bb4-5515c780948c';
const ING = '9b2f1c7e-4d3a-4b8e-9c1d-2e3f4a5b6c7d';
// `actorId` w trybie legacy wymaga UUID w payload.userId (inaczej UNAUTHORIZED).
const LEGACY_USER = '11111111-1111-4111-8111-111111111111';

const tokenClient = (userId: string) =>
  ({ data: { userId, mode: 'token' } }) as any;
const legacyClient = () => ({ data: { mode: 'legacy' } }) as any;
const anonClient = () => ({ data: {} }) as any;

describe('RecipesGateway', () => {
  let gateway: RecipesGateway;
  let emit: jest.Mock;
  let to: jest.Mock;
  let recipesService: Record<string, jest.Mock>;

  beforeEach(async () => {
    emit = jest.fn();
    to = jest.fn().mockReturnValue({ emit });
    const socketsJoin = jest.fn();
    const socketsLeave = jest.fn();
    const disconnectSockets = jest.fn();
    const inRoom = jest
      .fn()
      .mockReturnValue({ socketsJoin, socketsLeave, disconnectSockets });

    recipesService = {
      findAll: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      findById: jest.fn().mockResolvedValue({ id: RECIPE }),
      create: jest.fn().mockResolvedValue({ id: RECIPE }),
      // Serwis oddaje ack (`recipe`) i zwalidowaną zmianę do broadcastu.
      setFavorite: jest.fn().mockImplementation((_userId, data) =>
        Promise.resolve({
          recipe: { id: RECIPE, isFavorite: data.isFavorite },
          change: {
            recipeId: data.recipeId,
            householdId: data.householdId,
            isFavorite: data.isFavorite,
          },
        }),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecipesGateway,
        { provide: RecipesService, useValue: recipesService },
        {
          provide: WsTelemetryService,
          useValue: { onConnect: jest.fn(), onDisconnect: jest.fn() },
        },
      ],
    }).compile();

    gateway = module.get<RecipesGateway>(RecipesGateway);
    (gateway as any).server = { emit, to, in: inRoom };
  });

  const filters = { householdId: HH, page: 1, limit: 24 };
  const favoriteData = { recipeId: RECIPE, householdId: HH, isFavorite: true };
  // Pełne, poprawne DTO — koperta go nie waliduje (robi to serwis), ale test
  // nie ma utrwalać payloadu, którego serwis by odrzucił.
  const createData = {
    householdId: HH,
    title: 'Owsianka z bananem',
    mealType: 'BREAKFAST',
    difficulty: 'EASY',
    prepTimeMinutes: 10,
    servings: 2,
    ingredients: [{ ingredientId: ING, amount: 100, unit: 'g' }],
  };

  const expectNoServiceCalls = () => {
    for (const fn of Object.values(recipesService)) {
      expect(fn).not.toHaveBeenCalled();
    }
    expect(emit).not.toHaveBeenCalled();
    expect(to).not.toHaveBeenCalled();
  };

  // Tabela: event, wywołanie handlera z (client, userId w payloadzie),
  // metoda serwisu i argumenty, których serwis ma się spodziewać dla userId.
  const handlers: Array<{
    event: string;
    call: (client: any, userId?: string) => Promise<any>;
    method: string;
    serviceArgs: (userId: string) => unknown[];
  }> = [
    {
      event: 'recipes:findAll',
      call: (client, userId) =>
        gateway.findAll(client, { userId, householdId: HH, filters } as any),
      method: 'findAll',
      serviceArgs: (userId) => [userId, filters],
    },
    {
      event: 'recipes:findById',
      call: (client, userId) =>
        gateway.findById(client, {
          userId,
          id: RECIPE,
          householdId: HH,
        } as any),
      method: 'findById',
      serviceArgs: (userId) => [userId, RECIPE, HH],
    },
    {
      event: 'recipes:create',
      call: (client, userId) =>
        gateway.create(client, { userId, data: createData } as any),
      method: 'create',
      serviceArgs: (userId) => [userId, createData],
    },
    {
      event: 'recipes:setFavorite',
      call: (client, userId) =>
        gateway.setFavorite(client, { userId, data: favoriteData } as any),
      method: 'setFavorite',
      serviceArgs: (userId) => [userId, favoriteData],
    },
  ];

  describe.each(handlers)(
    '$event — tożsamość',
    ({ call, method, serviceArgs }) => {
      it('anonimowy socket dostaje UNAUTHORIZED w acku i nie dotyka serwisu', async () => {
        const response = await call(anonClient(), 'anyone');

        expect(response).toEqual(
          expect.objectContaining({
            ok: false,
            code: 'UNAUTHORIZED',
            status: 401,
          }),
        );
        expectNoServiceCalls();
      });

      it('socket z tokenem: payload.userId jest ignorowane, serwis dostaje sub tokenu', async () => {
        const response = await call(tokenClient('victim'), 'attacker');

        expect(response).toEqual(expect.objectContaining({ ok: true }));
        expect(recipesService[method]).toHaveBeenCalledTimes(1);
        expect(recipesService[method]).toHaveBeenCalledWith(
          ...serviceArgs('victim'),
        );
      });

      it('socket legacy: serwis dostaje userId z payloadu', async () => {
        const response = await call(legacyClient(), LEGACY_USER);

        expect(response).toEqual(expect.objectContaining({ ok: true }));
        expect(recipesService[method]).toHaveBeenCalledWith(
          ...serviceArgs(LEGACY_USER),
        );
      });
    },
  );

  // Koperta: zła koperta z ważną tożsamością → VALIDATION_ERROR z `details`,
  // serwis nietknięty. Anonim ze złą kopertą → nadal UNAUTHORIZED (kolejność:
  // tożsamość przed kopertą).
  const invalidEnvelopes: Array<{
    name: string;
    call: (client: any) => Promise<any>;
    detail: RegExp;
  }> = [
    {
      name: 'recipes:findAll z householdId nie-UUID',
      call: (client) =>
        gateway.findAll(client, { householdId: 'hh-1', filters } as any),
      detail: /householdId must be a UUID/,
    },
    {
      name: 'recipes:findAll z filters nie-obiektem',
      call: (client) => gateway.findAll(client, { filters: 'DINNER' } as any),
      detail: /filters must be an object/,
    },
    {
      name: 'recipes:findById bez id',
      call: (client) => gateway.findById(client, { householdId: HH } as any),
      detail: /id must be a UUID/,
    },
    {
      name: 'recipes:findById z id nie-UUID',
      call: (client) => gateway.findById(client, { id: 'recipe-1' } as any),
      detail: /id must be a UUID/,
    },
    {
      name: 'recipes:create bez data',
      call: (client) => gateway.create(client, {} as any),
      detail: /data must be an object/,
    },
    {
      name: 'recipes:create z data jako string',
      call: (client) => gateway.create(client, { data: 'Owsianka' } as any),
      detail: /data must be an object/,
    },
    {
      name: 'recipes:setFavorite bez data',
      call: (client) => gateway.setFavorite(client, {} as any),
      detail: /data must be an object/,
    },
    {
      name: 'recipes:setFavorite z payloadem undefined',
      call: (client) => gateway.setFavorite(client, undefined as any),
      detail: /data must be an object/,
    },
  ];

  describe.each(invalidEnvelopes)('koperta: $name', ({ call, detail }) => {
    it('socket z tokenem dostaje VALIDATION_ERROR 400 z details, serwis nietknięty', async () => {
      const response = await call(tokenClient('user-1'));

      expect(response).toEqual(
        expect.objectContaining({
          ok: false,
          code: 'VALIDATION_ERROR',
          status: 400,
          details: expect.arrayContaining([expect.stringMatching(detail)]),
        }),
      );
      expectNoServiceCalls();
    });

    it('anonimowy socket dostaje UNAUTHORIZED, nie VALIDATION_ERROR', async () => {
      const response = await call(anonClient());

      expect(response).toEqual(
        expect.objectContaining({ ok: false, code: 'UNAUTHORIZED' }),
      );
      expectNoServiceCalls();
    });
  });

  it('koperta: householdId UUID wielkimi literami przechodzi (iOS wysyła uuidString)', async () => {
    const response = await gateway.findById(tokenClient('user-1'), {
      id: RECIPE.toUpperCase(),
      householdId: HH.toUpperCase(),
    } as any);

    expect(response).toEqual(expect.objectContaining({ ok: true }));
    expect(recipesService.findById).toHaveBeenCalledWith(
      'user-1',
      RECIPE.toUpperCase(),
      HH.toUpperCase(),
    );
  });

  it('koperta: nieznane pola nie są błędem (stare buildy iOS je dokładają)', async () => {
    const response = await gateway.findAll(tokenClient('user-1'), {
      filters,
      clientVersion: '1.2.3',
    } as any);

    expect(response).toEqual(expect.objectContaining({ ok: true }));
    expect(recipesService.findAll).toHaveBeenCalledWith('user-1', filters);
  });

  describe('recipes:findAll', () => {
    it('zwraca wynik serwisu w kopercie ack', async () => {
      recipesService.findAll.mockResolvedValue({ items: [{ id: RECIPE }] });

      const response = await gateway.findAll(tokenClient('user-1'), {
        filters,
      } as any);

      expect(response).toEqual({
        ok: true,
        data: { items: [{ id: RECIPE }] },
      });
    });

    it('bez filtrów przekazuje undefined', async () => {
      await gateway.findAll(tokenClient('user-1'), {} as any);

      expect(recipesService.findAll).toHaveBeenCalledWith('user-1', undefined);
    });

    it('zawartości filters koperta nie waliduje — to robi serwis (jedna warstwa)', async () => {
      const badFilters = { mealType: 'BRUNCH' };

      const response = await gateway.findAll(tokenClient('user-1'), {
        filters: badFilters,
      } as any);

      expect(response).toEqual(expect.objectContaining({ ok: true }));
      expect(recipesService.findAll).toHaveBeenCalledWith('user-1', badFilters);
    });
  });

  describe('recipes:setFavorite', () => {
    it('ack to szczegóły przepisu; broadcast idzie do pokoju domu i legacy ze zwalidowanej zmiany', async () => {
      const response = await gateway.setFavorite(tokenClient('user-1'), {
        userId: 'attacker',
        data: favoriteData,
      } as any);

      expect(response).toEqual({
        ok: true,
        data: { id: RECIPE, isFavorite: true },
      });
      expect(to).toHaveBeenCalledTimes(1);
      expect(to).toHaveBeenCalledWith([`household:${HH}`, 'legacy']);
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith('recipes:favoritesChanged', {
        householdId: HH,
        recipeId: RECIPE,
        isFavorite: true,
        changedByUserId: 'user-1',
      });
    });

    it('broadcast używa zmiany oddanej przez serwis, nie surowego payload.data', async () => {
      const OTHER_HH = '22222222-2222-4222-8222-222222222222';
      recipesService.setFavorite.mockResolvedValue({
        recipe: { id: RECIPE, isFavorite: false },
        change: { recipeId: RECIPE, householdId: OTHER_HH, isFavorite: false },
      });

      await gateway.setFavorite(tokenClient('user-1'), {
        data: favoriteData,
      } as any);

      expect(to).toHaveBeenCalledWith([`household:${OTHER_HH}`, 'legacy']);
      expect(emit).toHaveBeenCalledWith('recipes:favoritesChanged', {
        householdId: OTHER_HH,
        recipeId: RECIPE,
        isFavorite: false,
        changedByUserId: 'user-1',
      });
    });

    it('socket legacy: changedByUserId pochodzi z payloadu', async () => {
      await gateway.setFavorite(legacyClient(), {
        userId: LEGACY_USER,
        data: { ...favoriteData, isFavorite: false },
      } as any);

      expect(to).toHaveBeenCalledWith([`household:${HH}`, 'legacy']);
      expect(emit).toHaveBeenCalledWith('recipes:favoritesChanged', {
        householdId: HH,
        recipeId: RECIPE,
        isFavorite: false,
        changedByUserId: LEGACY_USER,
      });
    });

    it('rozgłasza dopiero po zapisie w serwisie', async () => {
      await gateway.setFavorite(tokenClient('user-1'), {
        data: favoriteData,
      } as any);

      const [saved] = recipesService.setFavorite.mock.invocationCallOrder;
      const [broadcast] = emit.mock.invocationCallOrder;
      expect(saved).toBeLessThan(broadcast);
    });

    it('błąd serwisu wraca jako ok:false i niczego nie rozgłasza', async () => {
      recipesService.setFavorite.mockRejectedValue(new Error('boom'));

      const response = await gateway.setFavorite(tokenClient('user-1'), {
        data: favoriteData,
      } as any);

      expect(response).toEqual(expect.objectContaining({ ok: false }));
      expect(emit).not.toHaveBeenCalled();
      expect(to).not.toHaveBeenCalled();
    });
  });
});
