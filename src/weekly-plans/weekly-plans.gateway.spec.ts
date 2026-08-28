import { Test, TestingModule } from '@nestjs/testing';
import { WeeklyPlansGateway } from './weekly-plans.gateway';
import { WeeklyPlansService } from './weekly-plans.service';
import { ShoppingListService } from './services/shopping-list.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WsTelemetryService } from '../common/ws-telemetry.service';

// Gateway to cienka warstwa: woła serwis, rozgłasza zmianę i dokłada ją do
// paczki powiadomień. Te testy pilnują wyłącznie tego, CO wychodzi z jakiego
// `changeKind` — bo to jedyna logika, którą gateway ma na własność, i jedyna,
// która zdecydowała o „jeden push na podmianę, nie dwa".

const payload = {
  userId: 'user-1',
  householdId: 'hh-1',
  weekStart: '2026-04-13',
  data: {
    dayOfWeek: 'MON',
    mealType: 'DINNER',
    recipeId: '22222222-2222-4222-8222-222222222222',
  },
} as any;

describe('WeeklyPlansGateway', () => {
  let gateway: WeeklyPlansGateway;
  let emit: jest.Mock;
  let weeklyPlansService: {
    getUserDisplayName: jest.Mock;
    upsertWeekSlot: jest.Mock;
  };
  let notificationsService: {
    enqueueWeeklyPlanChange: jest.Mock;
    enqueueShoppingListChange: jest.Mock;
  };

  beforeEach(async () => {
    emit = jest.fn();
    weeklyPlansService = {
      getUserDisplayName: jest.fn().mockResolvedValue('Ania'),
      upsertWeekSlot: jest.fn(),
    };
    notificationsService = {
      enqueueWeeklyPlanChange: jest.fn(),
      enqueueShoppingListChange: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WeeklyPlansGateway,
        { provide: WeeklyPlansService, useValue: weeklyPlansService },
        { provide: ShoppingListService, useValue: {} },
        { provide: NotificationsService, useValue: notificationsService },
        {
          provide: WsTelemetryService,
          useValue: { onConnect: jest.fn(), onDisconnect: jest.fn() },
        },
      ],
    }).compile();

    gateway = module.get<WeeklyPlansGateway>(WeeklyPlansGateway);
    (gateway as any).server = { emit };
  });

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

      const response = await gateway.upsertWeekSlot(payload);

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

    it('REPLACED dokłada jedno powiadomienie', async () => {
      weeklyPlansService.upsertWeekSlot.mockResolvedValue({
        changeKind: 'REPLACED',
        replacedItemIds: ['plan-item-old'],
      });

      await gateway.upsertWeekSlot(payload);

      expect(
        notificationsService.enqueueWeeklyPlanChange,
      ).toHaveBeenCalledTimes(1);
      expect(notificationsService.enqueueWeeklyPlanChange).toHaveBeenCalledWith(
        expect.objectContaining({
          householdId: 'hh-1',
          changedByUserId: 'user-1',
          changedByDisplayName: 'Ania',
          action: 'UPSERT_SLOT',
          context: expect.objectContaining({
            dayOfWeek: 'MON',
            mealType: 'DINNER',
            weekStart: '2026-04-13',
          }),
        }),
      );
    });

    it('CREATED dokłada powiadomienie (regresja)', async () => {
      weeklyPlansService.upsertWeekSlot.mockResolvedValue({
        changeKind: 'CREATED',
        replacedItemIds: [],
      });

      await gateway.upsertWeekSlot(payload);

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

        await gateway.upsertWeekSlot(payload);

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

      const response = await gateway.upsertWeekSlot(payload);

      expect(response).toEqual(expect.objectContaining({ ok: false }));
      expect(emit).not.toHaveBeenCalled();
      expect(
        notificationsService.enqueueWeeklyPlanChange,
      ).not.toHaveBeenCalled();
    });
  });
});
