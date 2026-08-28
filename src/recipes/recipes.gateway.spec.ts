import { Test, TestingModule } from '@nestjs/testing';
import { RecipesGateway } from './recipes.gateway';
import { RecipesService } from './recipes.service';
import { WsTelemetryService } from '../common/ws-telemetry.service';

// Gateway ma na własność dwie rzeczy: skąd bierze tożsamość (socket z tokenem
// ignoruje payload.userId, socket legacy ufa mu jak dawniej, anonim dostaje
// UNAUTHORIZED w acku) i dokąd idzie `recipes:favoritesChanged` (pokój domu
// + legacy, nigdy do całego serwera). Reszta to przekazanie do serwisu.

const HH = 'hh-1';
const RECIPE = 'recipe-1';

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
      setFavorite: jest
        .fn()
        .mockResolvedValue({ id: RECIPE, isFavorite: true }),
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
  const createData = { householdId: HH, name: 'Owsianka' };

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
        for (const fn of Object.values(recipesService)) {
          expect(fn).not.toHaveBeenCalled();
        }
        expect(emit).not.toHaveBeenCalled();
        expect(to).not.toHaveBeenCalled();
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
        const response = await call(legacyClient(), 'legacy-user');

        expect(response).toEqual(expect.objectContaining({ ok: true }));
        expect(recipesService[method]).toHaveBeenCalledWith(
          ...serviceArgs('legacy-user'),
        );
      });
    },
  );

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
  });

  describe('recipes:setFavorite', () => {
    it('rozgłasza favoritesChanged do pokoju domu i legacy z tożsamością z socketu', async () => {
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

    it('socket legacy: changedByUserId pochodzi z payloadu', async () => {
      await gateway.setFavorite(legacyClient(), {
        userId: 'legacy-user',
        data: { ...favoriteData, isFavorite: false },
      } as any);

      expect(to).toHaveBeenCalledWith([`household:${HH}`, 'legacy']);
      expect(emit).toHaveBeenCalledWith('recipes:favoritesChanged', {
        householdId: HH,
        recipeId: RECIPE,
        isFavorite: false,
        changedByUserId: 'legacy-user',
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
