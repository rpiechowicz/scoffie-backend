import { Test, TestingModule } from '@nestjs/testing';
import { WeeklyPlansGateway } from './weekly-plans.gateway';
import { WeeklyPlansService } from './weekly-plans.service';
import { ShoppingListService } from './services/shopping-list.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WsTelemetryService } from '../common/ws-telemetry.service';

// Gateway to cienka warstwa: woła serwis, rozgłasza zmianę i dokłada ją do
// paczki powiadomień. Te testy pilnują wyłącznie tego, CO wychodzi z jakiego
// `changeKind` — bo to jedyna logika, którą gateway ma na własność, i jedyna,
// która zdecydowała o „jeden push na podmianę, nie dwa". Od Fazy 0 dochodzi
// druga rzecz na własność: tożsamość bierze się z socketu (`actorId`), a
// broadcast idzie do pokoju gospodarstwa, nie do wszystkich.

const USER = 'user-1';
const HH = 'hh-1';
const WEEK = '2026-04-13';

const payload = {
  userId: USER,
  householdId: HH,
  weekStart: WEEK,
  data: {
    dayOfWeek: 'MON',
    mealType: 'DINNER',
    recipeId: '22222222-2222-4222-8222-222222222222',
  },
} as any;

const tokenClient = (userId: string) =>
  ({ data: { userId, mode: 'token' } }) as any;
const legacyClient = () => ({ data: { mode: 'legacy' } }) as any;
const anonClient = () => ({ data: {} }) as any;

describe('WeeklyPlansGateway', () => {
  let gateway: WeeklyPlansGateway;
  let emit: jest.Mock;
  let to: jest.Mock;
  let inRoom: jest.Mock;
  let weeklyPlansService: Record<string, jest.Mock>;
  let shoppingListService: Record<string, jest.Mock>;
  let notificationsService: Record<string, jest.Mock>;

  beforeEach(async () => {
    emit = jest.fn();
    to = jest.fn().mockReturnValue({ emit });
    const socketsJoin = jest.fn();
    const socketsLeave = jest.fn();
    const disconnectSockets = jest.fn();
    inRoom = jest
      .fn()
      .mockReturnValue({ socketsJoin, socketsLeave, disconnectSockets });

    weeklyPlansService = {
      getUserDisplayName: jest.fn().mockResolvedValue('Ania'),
      getByHouseholdAndWeek: jest.fn().mockResolvedValue({ items: [] }),
      upsertWeekSlot: jest.fn(),
      removeWeekSlot: jest.fn().mockResolvedValue({ id: 'plan-item-1' }),
      setMealEaten: jest.fn().mockResolvedValue({ id: 'plan-item-1' }),
      clearWeekPlan: jest.fn().mockResolvedValue({ removed: 3 }),
    };
    shoppingListService = {
      getShoppingList: jest.fn().mockResolvedValue({ items: [] }),
      getShoppingListState: jest.fn().mockResolvedValue({ checked: [] }),
      archiveShoppingList: jest.fn().mockResolvedValue({ id: 'arch-1' }),
      selectShoppingListArchive: jest
        .fn()
        .mockResolvedValue({ id: 'arch-1', weekStart: WEEK }),
      deleteShoppingListArchive: jest
        .fn()
        .mockResolvedValue({ id: 'arch-1', weekStart: WEEK }),
      deleteAllShoppingListArchives: jest
        .fn()
        .mockResolvedValue({ deleted: 2 }),
      setShoppingItemChecked: jest.fn().mockResolvedValue({ ok: true }),
    };
    notificationsService = {
      enqueueWeeklyPlanChange: jest.fn(),
      enqueueShoppingListChange: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WeeklyPlansGateway,
        { provide: WeeklyPlansService, useValue: weeklyPlansService },
        { provide: ShoppingListService, useValue: shoppingListService },
        { provide: NotificationsService, useValue: notificationsService },
        {
          provide: WsTelemetryService,
          useValue: { onConnect: jest.fn(), onDisconnect: jest.fn() },
        },
      ],
    }).compile();

    gateway = module.get<WeeklyPlansGateway>(WeeklyPlansGateway);
    (gateway as any).server = { emit, to, in: inRoom };
  });

  const allServiceMocks = () => [
    ...Object.values(weeklyPlansService),
    ...Object.values(shoppingListService),
    ...Object.values(notificationsService),
  ];

  describe('weeklyPlans:upsertWeekSlot', () => {
    const emittedActions = (event: string) =>
      emit.mock.calls
        .filter(([name]) => name === event)
        .map(([, body]) => body.action);

    it('podmiana rozgłasza się RAZ, jako UPSERT_SLOT', async () => {
      weeklyPlansService.upsertWeekSlot.mockResolvedValue({
        changeKind: 'REPLACED',
        replacedItemIds: ['plan-item-old'],
      });

      const response = await gateway.upsertWeekSlot(tokenClient(USER), payload);

      expect(response).toEqual(
        expect.objectContaining({
          ok: true,
          data: expect.objectContaining({ changeKind: 'REPLACED' }),
        }),
      );
      expect(emit).toHaveBeenCalledTimes(2);
      expect(emittedActions('weeklyPlans:weekChanged')).toEqual([
        'UPSERT_SLOT',
      ]);
      expect(emittedActions('weeklyPlans:shoppingListChanged')).toEqual([
        'UPSERT_SLOT',
      ]);
      expect(emittedActions('weeklyPlans:weekChanged')).not.toContain(
        'REMOVE_SLOT',
      );
    });

    it('oba broadcasty idą do pokoju gospodarstwa i legacy, nie globalnie', async () => {
      weeklyPlansService.upsertWeekSlot.mockResolvedValue({
        changeKind: 'CREATED',
        replacedItemIds: [],
      });

      await gateway.upsertWeekSlot(tokenClient(USER), payload);

      expect(to).toHaveBeenCalledTimes(2);
      for (const [rooms] of to.mock.calls) {
        expect(rooms).toEqual([`household:${HH}`, 'legacy']);
      }
      expect(emit).toHaveBeenCalledWith(
        'weeklyPlans:weekChanged',
        expect.objectContaining({
          householdId: HH,
          weekStart: WEEK,
          action: 'UPSERT_SLOT',
          changedByUserId: USER,
          changedByDisplayName: 'Ania',
          dayOfWeek: 'MON',
          mealType: 'DINNER',
        }),
      );
      expect(emit).toHaveBeenCalledWith(
        'weeklyPlans:shoppingListChanged',
        expect.objectContaining({
          householdId: HH,
          weekStart: WEEK,
          action: 'UPSERT_SLOT',
          changedByUserId: USER,
        }),
      );
    });

    it('REPLACED dokłada jedno powiadomienie', async () => {
      weeklyPlansService.upsertWeekSlot.mockResolvedValue({
        changeKind: 'REPLACED',
        replacedItemIds: ['plan-item-old'],
      });

      await gateway.upsertWeekSlot(tokenClient(USER), payload);

      expect(
        notificationsService.enqueueWeeklyPlanChange,
      ).toHaveBeenCalledTimes(1);
      expect(notificationsService.enqueueWeeklyPlanChange).toHaveBeenCalledWith(
        expect.objectContaining({
          householdId: HH,
          changedByUserId: USER,
          changedByDisplayName: 'Ania',
          action: 'UPSERT_SLOT',
          context: expect.objectContaining({
            dayOfWeek: 'MON',
            mealType: 'DINNER',
            weekStart: WEEK,
          }),
        }),
      );
    });

    it('CREATED dokłada powiadomienie (regresja)', async () => {
      weeklyPlansService.upsertWeekSlot.mockResolvedValue({
        changeKind: 'CREATED',
        replacedItemIds: [],
      });

      await gateway.upsertWeekSlot(tokenClient(USER), payload);

      expect(
        notificationsService.enqueueWeeklyPlanChange,
      ).toHaveBeenCalledTimes(1);
    });

    it.each(['DETAILS_CHANGED', 'NOOP'])(
      '%s rozgłasza zmianę, ale nie wysyła powiadomienia',
      async (changeKind) => {
        weeklyPlansService.upsertWeekSlot.mockResolvedValue({
          changeKind,
          replacedItemIds: [],
        });

        await gateway.upsertWeekSlot(tokenClient(USER), payload);

        expect(emittedActions('weeklyPlans:weekChanged')).toEqual([
          'UPSERT_SLOT',
        ]);
        expect(
          notificationsService.enqueueWeeklyPlanChange,
        ).not.toHaveBeenCalled();
      },
    );

    it('błąd serwisu wraca jako ok:false i niczego nie rozgłasza', async () => {
      weeklyPlansService.upsertWeekSlot.mockRejectedValue(new Error('boom'));

      const response = await gateway.upsertWeekSlot(tokenClient(USER), payload);

      expect(response).toEqual(expect.objectContaining({ ok: false }));
      expect(emit).not.toHaveBeenCalled();
      expect(
        notificationsService.enqueueWeeklyPlanChange,
      ).not.toHaveBeenCalled();
    });
  });

  describe('tożsamość z socketu (Faza 0)', () => {
    // Każdy handler: `svc` to mock, który ma dostać userId jako PIERWSZY
    // argument; `null` dla stubu `getSavedPlan`, który nie woła serwisu.
    // `broadcasts` to zdarzenia, które muszą wyjść do pokoju gospodarstwa
    // (z `changedByUserId` z socketu, nie z payloadu).
    type Case = {
      event: string;
      call: (client: any, body: any) => Promise<any>;
      body: Record<string, unknown>;
      svc: () => jest.Mock | null;
      broadcasts: string[];
    };

    const base = { householdId: HH, weekStart: WEEK };
    const cases: Case[] = [
      {
        event: 'weeklyPlans:getByWeek',
        call: (c, b) => gateway.getByWeek(c, b),
        body: base,
        svc: () => weeklyPlansService.getByHouseholdAndWeek,
        broadcasts: [],
      },
      {
        event: 'weeklyPlans:getShoppingList',
        call: (c, b) => gateway.getShoppingList(c, b),
        body: base,
        svc: () => shoppingListService.getShoppingList,
        broadcasts: [],
      },
      {
        event: 'weeklyPlans:getShoppingListState',
        call: (c, b) => gateway.getShoppingListState(c, b),
        body: base,
        svc: () => shoppingListService.getShoppingListState,
        broadcasts: [],
      },
      {
        event: 'weeklyPlans:archiveShoppingList',
        call: (c, b) => gateway.archiveShoppingList(c, b),
        body: { ...base, weekLabel: 'Tydzień 16' },
        svc: () => shoppingListService.archiveShoppingList,
        broadcasts: ['weeklyPlans:shoppingListChanged'],
      },
      {
        event: 'weeklyPlans:selectShoppingListArchive',
        call: (c, b) => gateway.selectShoppingListArchive(c, b),
        body: { householdId: HH, archiveId: 'arch-1' },
        svc: () => shoppingListService.selectShoppingListArchive,
        broadcasts: ['weeklyPlans:shoppingListChanged'],
      },
      {
        event: 'weeklyPlans:deleteShoppingListArchive',
        call: (c, b) => gateway.deleteShoppingListArchive(c, b),
        body: { householdId: HH, archiveId: 'arch-1' },
        svc: () => shoppingListService.deleteShoppingListArchive,
        broadcasts: ['weeklyPlans:shoppingListChanged'],
      },
      {
        event: 'weeklyPlans:deleteAllShoppingListArchives',
        call: (c, b) => gateway.deleteAllShoppingListArchives(c, b),
        body: base,
        svc: () => shoppingListService.deleteAllShoppingListArchives,
        broadcasts: ['weeklyPlans:shoppingListChanged'],
      },
      {
        event: 'weeklyPlans:setShoppingItemChecked',
        call: (c, b) => gateway.setShoppingItemChecked(c, b),
        body: { ...base, data: { productKey: 'mleko', isChecked: true } },
        svc: () => shoppingListService.setShoppingItemChecked,
        broadcasts: ['weeklyPlans:shoppingListChanged'],
      },
      {
        event: 'weeklyPlans:upsertWeekSlot',
        call: (c, b) => gateway.upsertWeekSlot(c, b),
        body: { ...base, data: payload.data },
        svc: () => weeklyPlansService.upsertWeekSlot,
        broadcasts: [
          'weeklyPlans:weekChanged',
          'weeklyPlans:shoppingListChanged',
        ],
      },
      {
        event: 'weeklyPlans:removeWeekSlot',
        call: (c, b) => gateway.removeWeekSlot(c, b),
        body: { ...base, data: { dayOfWeek: 'MON', mealType: 'DINNER' } },
        svc: () => weeklyPlansService.removeWeekSlot,
        broadcasts: [
          'weeklyPlans:weekChanged',
          'weeklyPlans:shoppingListChanged',
        ],
      },
      {
        event: 'weeklyPlans:setMealEaten',
        call: (c, b) => gateway.setMealEaten(c, b),
        body: {
          ...base,
          data: { dayOfWeek: 'MON', mealType: 'DINNER', isEaten: true },
        },
        svc: () => weeklyPlansService.setMealEaten,
        broadcasts: ['weeklyPlans:weekChanged'],
      },
      {
        event: 'weeklyPlans:getSavedPlan',
        call: (c, b) => gateway.getSavedPlan(c, b),
        body: base,
        svc: () => null,
        broadcasts: [],
      },
      {
        event: 'weeklyPlans:clearWeekPlan',
        call: (c, b) => gateway.clearWeekPlan(c, b),
        body: base,
        svc: () => weeklyPlansService.clearWeekPlan,
        broadcasts: [
          'weeklyPlans:weekChanged',
          'weeklyPlans:shoppingListChanged',
        ],
      },
    ];

    it('tabela pokrywa wszystkie handlery gatewaya', () => {
      expect(cases).toHaveLength(13);
      expect(new Set(cases.map((c) => c.event)).size).toBe(13);
    });

    describe.each(cases)('$event', ({ call, body, svc, broadcasts }) => {
      it('anonimowy socket dostaje UNAUTHORIZED, serwis nietknięty', async () => {
        const response = await call(anonClient(), { ...body, userId: USER });

        expect(response).toEqual(
          expect.objectContaining({
            ok: false,
            code: 'UNAUTHORIZED',
            status: 401,
          }),
        );
        for (const mock of allServiceMocks()) {
          expect(mock).not.toHaveBeenCalled();
        }
        expect(to).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
      });

      it('socket z tokenem: payload.userId ignorowane, liczy się sub tokenu', async () => {
        const response = await call(tokenClient('victim'), {
          ...body,
          userId: 'attacker',
        });

        expect(response).toEqual(expect.objectContaining({ ok: true }));
        const mock = svc();
        if (mock) {
          expect(mock).toHaveBeenCalledTimes(1);
          expect(mock.mock.calls[0][0]).toBe('victim');
        }
        if (weeklyPlansService.getUserDisplayName.mock.calls.length > 0) {
          expect(weeklyPlansService.getUserDisplayName).toHaveBeenCalledWith(
            'victim',
          );
        }
        for (const enqueue of Object.values(notificationsService)) {
          for (const [input] of enqueue.mock.calls) {
            expect(input.changedByUserId).toBe('victim');
          }
        }
      });

      it('socket legacy: tożsamość z payload.userId jak dawniej', async () => {
        const response = await call(legacyClient(), {
          ...body,
          userId: 'legacy-user',
        });

        expect(response).toEqual(expect.objectContaining({ ok: true }));
        const mock = svc();
        if (mock) {
          expect(mock).toHaveBeenCalledTimes(1);
          expect(mock.mock.calls[0][0]).toBe('legacy-user');
        }
      });

      it('socket legacy bez userId w payloadzie dostaje UNAUTHORIZED', async () => {
        const response = await call(legacyClient(), body);

        expect(response).toEqual(
          expect.objectContaining({ ok: false, code: 'UNAUTHORIZED' }),
        );
        for (const mock of allServiceMocks()) {
          expect(mock).not.toHaveBeenCalled();
        }
      });

      if (broadcasts.length > 0) {
        it('rozgłasza do pokoju gospodarstwa i legacy z tożsamością z socketu', async () => {
          if (svc() === weeklyPlansService.upsertWeekSlot) {
            weeklyPlansService.upsertWeekSlot.mockResolvedValue({
              changeKind: 'CREATED',
              replacedItemIds: [],
            });
          }

          await call(tokenClient('victim'), { ...body, userId: 'attacker' });

          expect(to).toHaveBeenCalledTimes(broadcasts.length);
          for (const [rooms] of to.mock.calls) {
            expect(rooms).toEqual([`household:${HH}`, 'legacy']);
          }
          expect(emit.mock.calls.map(([name]) => name)).toEqual(broadcasts);
          for (const [, eventBody] of emit.mock.calls) {
            expect(eventBody).toEqual(
              expect.objectContaining({
                householdId: HH,
                changedByUserId: 'victim',
                changeVersion: expect.any(Number),
              }),
            );
          }
          expect(inRoom).not.toHaveBeenCalled();
        });
      } else {
        it('niczego nie rozgłasza', async () => {
          await call(tokenClient('victim'), { ...body, userId: 'attacker' });

          expect(to).not.toHaveBeenCalled();
          expect(emit).not.toHaveBeenCalled();
        });
      }
    });

    it('getSavedPlan odpowiada pustą pulą, ale wciąż wymaga tożsamości', async () => {
      const ok = await gateway.getSavedPlan(tokenClient(USER), base as any);
      expect(ok).toEqual({ ok: true, data: { weekStart: WEEK, items: [] } });

      const denied = await gateway.getSavedPlan(anonClient(), base as any);
      expect(denied).toEqual(
        expect.objectContaining({ ok: false, code: 'UNAUTHORIZED' }),
      );
    });

    it('removeWeekSlot bez trafienia (falsy) nie rozgłasza, ale tożsamość i tak z socketu', async () => {
      weeklyPlansService.removeWeekSlot.mockResolvedValue(null);

      const response = await gateway.removeWeekSlot(tokenClient('victim'), {
        ...base,
        userId: 'attacker',
        data: { dayOfWeek: 'MON', mealType: 'DINNER' },
      } as any);

      expect(response).toEqual(expect.objectContaining({ ok: true }));
      expect(weeklyPlansService.removeWeekSlot.mock.calls[0][0]).toBe('victim');
      expect(to).not.toHaveBeenCalled();
      expect(
        notificationsService.enqueueWeeklyPlanChange,
      ).not.toHaveBeenCalled();
    });
  });
});
