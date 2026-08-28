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

// Prawdziwe UUID v4: koperty mają od Fazy 0 `@IsUUID()` na `householdId`
// i `archiveId`, a `actorId` w trybie legacy wymaga UUID w `payload.userId`.
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LEGACY_USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const HH = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const ARCHIVE = '44444444-4444-4444-8444-444444444444';
const RECIPE = '22222222-2222-4222-8222-222222222222';
const WEEK = '2026-04-13';

const payload = {
  userId: USER,
  householdId: HH,
  weekStart: WEEK,
  data: {
    dayOfWeek: 'MON',
    mealType: 'DINNER',
    recipeId: RECIPE,
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
    // `invalid`: złe koperty, które handler ma odbić ackiem VALIDATION_ERROR
    // ZANIM zawoła serwis (walidacja koperty w gatewayu; `data` waliduje
    // serwis, więc tu tylko brak/typ `data`, nie jego zawartość).
    type Case = {
      event: string;
      call: (client: any, body: any) => Promise<any>;
      body: Record<string, unknown>;
      svc: () => jest.Mock | null;
      broadcasts: string[];
      invalid: Array<[label: string, body: unknown]>;
    };

    const base = { householdId: HH, weekStart: WEEK };
    const invalidWeekEnvelope: Case['invalid'] = [
      ['payload undefined', undefined],
      ['householdId nie-UUID', { householdId: 'hh-1', weekStart: WEEK }],
      ['brak householdId', { weekStart: WEEK }],
      ['weekStart liczbą', { householdId: HH, weekStart: 20260413 }],
    ];
    const invalidDataEnvelope = (data: unknown): Case['invalid'] => [
      ...invalidWeekEnvelope,
      ['brak data', base],
      ['data napisem', { ...base, data: 'MON' }],
      ['data tablicą', { ...base, data: [data] }],
    ];
    const cases: Case[] = [
      {
        event: 'weeklyPlans:getByWeek',
        call: (c, b) => gateway.getByWeek(c, b),
        body: base,
        svc: () => weeklyPlansService.getByHouseholdAndWeek,
        broadcasts: [],
        invalid: invalidWeekEnvelope,
      },
      {
        event: 'weeklyPlans:getShoppingList',
        call: (c, b) => gateway.getShoppingList(c, b),
        body: base,
        svc: () => shoppingListService.getShoppingList,
        broadcasts: [],
        invalid: invalidWeekEnvelope,
      },
      {
        event: 'weeklyPlans:getShoppingListState',
        call: (c, b) => gateway.getShoppingListState(c, b),
        body: base,
        svc: () => shoppingListService.getShoppingListState,
        broadcasts: [],
        invalid: invalidWeekEnvelope,
      },
      {
        event: 'weeklyPlans:archiveShoppingList',
        call: (c, b) => gateway.archiveShoppingList(c, b),
        body: { ...base, weekLabel: 'Tydzień 16' },
        svc: () => shoppingListService.archiveShoppingList,
        broadcasts: ['weeklyPlans:shoppingListChanged'],
        invalid: [
          ...invalidWeekEnvelope,
          ['brak weekLabel', base],
          ['weekLabel liczbą', { ...base, weekLabel: 16 }],
          ['weekLabel za długi', { ...base, weekLabel: 'x'.repeat(65) }],
        ],
      },
      {
        event: 'weeklyPlans:selectShoppingListArchive',
        call: (c, b) => gateway.selectShoppingListArchive(c, b),
        body: { householdId: HH, archiveId: ARCHIVE },
        svc: () => shoppingListService.selectShoppingListArchive,
        broadcasts: ['weeklyPlans:shoppingListChanged'],
        invalid: [
          ['payload undefined', undefined],
          ['archiveId nie-UUID', { householdId: HH, archiveId: 'arch-1' }],
          ['brak archiveId', { householdId: HH }],
          ['householdId nie-UUID', { householdId: 'hh-1', archiveId: ARCHIVE }],
        ],
      },
      {
        event: 'weeklyPlans:deleteShoppingListArchive',
        call: (c, b) => gateway.deleteShoppingListArchive(c, b),
        body: { householdId: HH, archiveId: ARCHIVE },
        svc: () => shoppingListService.deleteShoppingListArchive,
        broadcasts: ['weeklyPlans:shoppingListChanged'],
        invalid: [
          ['payload undefined', undefined],
          ['archiveId nie-UUID', { householdId: HH, archiveId: 'arch-1' }],
          ['brak archiveId', { householdId: HH }],
        ],
      },
      {
        event: 'weeklyPlans:deleteAllShoppingListArchives',
        call: (c, b) => gateway.deleteAllShoppingListArchives(c, b),
        body: base,
        svc: () => shoppingListService.deleteAllShoppingListArchives,
        broadcasts: ['weeklyPlans:shoppingListChanged'],
        invalid: invalidWeekEnvelope,
      },
      {
        event: 'weeklyPlans:setShoppingItemChecked',
        call: (c, b) => gateway.setShoppingItemChecked(c, b),
        body: { ...base, data: { productKey: 'mleko', isChecked: true } },
        svc: () => shoppingListService.setShoppingItemChecked,
        broadcasts: ['weeklyPlans:shoppingListChanged'],
        invalid: invalidDataEnvelope({ productKey: 'mleko', isChecked: true }),
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
        invalid: invalidDataEnvelope(payload.data),
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
        invalid: invalidDataEnvelope({ dayOfWeek: 'MON', mealType: 'DINNER' }),
      },
      {
        event: 'weeklyPlans:setMealEaten',
        call: (c, b) => gateway.setMealEaten(c, b),
        body: {
          ...base,
          data: {
            dayOfWeek: 'MON',
            mealType: 'DINNER',
            recipeId: RECIPE,
            isEaten: true,
          },
        },
        svc: () => weeklyPlansService.setMealEaten,
        broadcasts: ['weeklyPlans:weekChanged'],
        invalid: invalidDataEnvelope({
          dayOfWeek: 'MON',
          mealType: 'DINNER',
          recipeId: RECIPE,
          isEaten: true,
        }),
      },
      {
        event: 'weeklyPlans:getSavedPlan',
        call: (c, b) => gateway.getSavedPlan(c, b),
        body: base,
        svc: () => null,
        broadcasts: [],
        invalid: invalidWeekEnvelope,
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
        invalid: invalidWeekEnvelope,
      },
    ];

    it('tabela pokrywa wszystkie handlery gatewaya', () => {
      expect(cases).toHaveLength(13);
      expect(new Set(cases.map((c) => c.event)).size).toBe(13);
    });

    describe.each(cases)(
      '$event',
      ({ call, body, svc, broadcasts, invalid }) => {
        // ─── Walidacja koperty (Faza 0, krok 2) ───────────────────────────
        //
        // Zła koperta = ack VALIDATION_ERROR z `details`, serwis nie
        // wywołany, nic nie rozgłoszone. Kolejność z `actorId`: anonimowy
        // socket dostaje UNAUTHORIZED także ze złą kopertą.

        it.each(invalid)(
          'zła koperta (%s) → ack VALIDATION_ERROR 400, serwis nietknięty',
          async (_label, invalidBody) => {
            const response = await call(tokenClient(USER), invalidBody);

            expect(response).toEqual(
              expect.objectContaining({
                ok: false,
                code: 'VALIDATION_ERROR',
                status: 400,
                details: expect.arrayContaining([expect.any(String)]),
              }),
            );
            for (const mock of allServiceMocks()) {
              expect(mock).not.toHaveBeenCalled();
            }
            expect(to).not.toHaveBeenCalled();
            expect(emit).not.toHaveBeenCalled();
          },
        );

        it('anonimowy socket ze złą kopertą dostaje UNAUTHORIZED, nie VALIDATION_ERROR', async () => {
          const response = await call(anonClient(), invalid[0][1]);

          expect(response).toEqual(
            expect.objectContaining({ ok: false, code: 'UNAUTHORIZED' }),
          );
        });

        it('nieznane pole na kopercie (stary build iOS) nie jest błędem', async () => {
          const response = await call(tokenClient(USER), {
            ...body,
            userId: USER,
            legacyFlag: true,
          });

          expect(response).toEqual(expect.objectContaining({ ok: true }));
        });

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
            userId: LEGACY_USER,
          });

          expect(response).toEqual(expect.objectContaining({ ok: true }));
          const mock = svc();
          if (mock) {
            expect(mock).toHaveBeenCalledTimes(1);
            expect(mock.mock.calls[0][0]).toBe(LEGACY_USER);
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
      },
    );

    it('zawartość `data` NIE jest walidowana w gatewayu — to robi serwis, dokładnie raz', async () => {
      // Koperta ma tylko `@IsObject()` na `data`; zły enum w środku dociera
      // do (zamockowanego) serwisu. W produkcji `validateDto` w serwisie
      // odbija go z listą wartości — bez duplikatu `details` z gatewaya.
      weeklyPlansService.upsertWeekSlot.mockResolvedValue({
        changeKind: 'CREATED',
        replacedItemIds: [],
      });

      const response = await gateway.upsertWeekSlot(tokenClient(USER), {
        ...base,
        data: { ...payload.data, dayOfWeek: 'MONDAY' },
      } as any);

      expect(response).toEqual(expect.objectContaining({ ok: true }));
      expect(weeklyPlansService.upsertWeekSlot).toHaveBeenCalledWith(
        USER,
        HH,
        WEEK,
        expect.objectContaining({ dayOfWeek: 'MONDAY' }),
      );
    });

    it('UUID wielkimi literami w kopercie (iOS `uuidString`) przechodzi', async () => {
      const response = await gateway.getByWeek(tokenClient(USER), {
        householdId: HH.toUpperCase(),
        weekStart: WEEK,
      } as any);

      expect(response).toEqual(expect.objectContaining({ ok: true }));
      expect(weeklyPlansService.getByHouseholdAndWeek).toHaveBeenCalledWith(
        USER,
        HH.toUpperCase(),
        WEEK,
      );
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
