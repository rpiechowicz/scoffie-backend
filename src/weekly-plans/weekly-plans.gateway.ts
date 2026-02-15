import { MessageBody, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { WS_GATEWAY_OPTIONS } from '../common/ws-gateway-options';
import { wsRespond } from '../common/ws-response';
import { WeeklyPlansService } from './weekly-plans.service';
import { CreatePlanItemDto } from './dto/create-plan-item.dto';
import { CreateWeeklyPlanDto } from './dto/create-weekly-plan.dto';
import { UpdateShoppingItemCheckDto } from './dto/update-shopping-item-check.dto';
import { UpsertWeekSlotDto } from './dto/upsert-week-slot.dto';
import { RemoveWeekSlotDto } from './dto/remove-week-slot.dto';
import { Server } from 'socket.io';
import { SaveSharedMealPlanDto } from './dto/save-shared-meal-plan.dto';
import { NotificationsService } from '../notifications/notifications.service';

class WeeklyPlansListPayload {
  userId: string;
  householdId: string;
}

class WeeklyPlansGetByWeekPayload {
  userId: string;
  householdId: string;
  weekStart: string;
}

class WeeklyPlansCreatePayload {
  userId: string;
  householdId: string;
  data: CreateWeeklyPlanDto;
}

class WeeklyPlansAddItemPayload {
  userId: string;
  weeklyPlanId: string;
  data: CreatePlanItemDto;
}

class WeeklyPlansRemoveItemPayload {
  userId: string;
  itemId: string;
}

class WeeklyPlansGetShoppingListPayload {
  userId: string;
  householdId: string;
  weekStart: string;
}

class WeeklyPlansSetShoppingItemCheckedPayload {
  userId: string;
  householdId: string;
  weekStart: string;
  data: UpdateShoppingItemCheckDto;
}

class WeeklyPlansUpsertWeekSlotPayload {
  userId: string;
  householdId: string;
  weekStart: string;
  data: UpsertWeekSlotDto;
}

class WeeklyPlansRemoveWeekSlotPayload {
  userId: string;
  householdId: string;
  weekStart: string;
  data: RemoveWeekSlotDto;
}

class WeeklyPlansGetSavedPlanPayload {
  userId: string;
  householdId: string;
  weekStart: string;
}

class WeeklyPlansSaveSavedPlanPayload {
  userId: string;
  householdId: string;
  weekStart: string;
  data: SaveSharedMealPlanDto;
}

class WeeklyPlansClearWeekPlanPayload {
  userId: string;
  householdId: string;
  weekStart: string;
}

@WebSocketGateway(WS_GATEWAY_OPTIONS)
export class WeeklyPlansGateway {
  @WebSocketServer()
  private server: Server;

  constructor(
    private readonly weeklyPlansService: WeeklyPlansService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private notifyPlanChanged(
    householdId: string,
    changedByUserId: string,
    changedByDisplayName: string | null | undefined,
    action: string,
    context?: { dayOfWeek?: string | null; mealType?: string | null; weekStart?: string | null },
  ): void {
    void this.notificationsService
      .notifyWeeklyPlanChanged({
        householdId,
        changedByUserId,
        changedByDisplayName,
        action,
        context,
      })
      .catch(() => undefined);
  }

  private buildSavedPlanFingerprint(plan: { items?: Array<{ mealType: string; quantity: number; recipe: { id: string } }> } | null | undefined): string {
    const items = plan?.items ?? [];
    return items
      .map((item) => `${item.mealType}:${item.recipe.id}:${item.quantity}`)
      .sort()
      .join('|');
  }

  @SubscribeMessage('weeklyPlans:listByHousehold')
  listByHousehold(@MessageBody() payload: WeeklyPlansListPayload) {
    return wsRespond(() => this.weeklyPlansService.listByHousehold(payload.userId, payload.householdId));
  }

  @SubscribeMessage('weeklyPlans:getByWeek')
  getByWeek(@MessageBody() payload: WeeklyPlansGetByWeekPayload) {
    return wsRespond(() =>
      this.weeklyPlansService.getByHouseholdAndWeek(payload.userId, payload.householdId, payload.weekStart),
    );
  }

  @SubscribeMessage('weeklyPlans:create')
  create(@MessageBody() payload: WeeklyPlansCreatePayload) {
    return wsRespond(() => this.weeklyPlansService.create(payload.userId, payload.householdId, payload.data));
  }

  @SubscribeMessage('weeklyPlans:addItem')
  addItem(@MessageBody() payload: WeeklyPlansAddItemPayload) {
    return wsRespond(() => this.weeklyPlansService.addItem(payload.userId, payload.weeklyPlanId, payload.data));
  }

  @SubscribeMessage('weeklyPlans:removeItem')
  removeItem(@MessageBody() payload: WeeklyPlansRemoveItemPayload) {
    return wsRespond(() => this.weeklyPlansService.removeItem(payload.userId, payload.itemId));
  }

  @SubscribeMessage('weeklyPlans:getShoppingList')
  getShoppingList(@MessageBody() payload: WeeklyPlansGetShoppingListPayload) {
    return wsRespond(() =>
      this.weeklyPlansService.getShoppingList(payload.userId, payload.householdId, payload.weekStart),
    );
  }

  @SubscribeMessage('weeklyPlans:setShoppingItemChecked')
  setShoppingItemChecked(@MessageBody() payload: WeeklyPlansSetShoppingItemCheckedPayload) {
    return wsRespond(async () => {
      const result = await this.weeklyPlansService.setShoppingItemChecked(
        payload.userId,
        payload.householdId,
        payload.weekStart,
        payload.data,
      );

      this.server.emit('weeklyPlans:shoppingListChanged', {
        householdId: payload.householdId,
        weekStart: payload.weekStart,
        productKey: payload.data.productKey,
        isChecked: payload.data.isChecked,
      });

      return result;
    });
  }

  @SubscribeMessage('weeklyPlans:upsertWeekSlot')
  upsertWeekSlot(@MessageBody() payload: WeeklyPlansUpsertWeekSlotPayload) {
    return wsRespond(async () => {
      const changedByDisplayName = await this.weeklyPlansService.getUserDisplayName(payload.userId);
      const result = await this.weeklyPlansService.upsertWeekSlot(
        payload.userId,
        payload.householdId,
        payload.weekStart,
        payload.data,
      );

      this.server.emit('weeklyPlans:weekChanged', {
        householdId: payload.householdId,
        weekStart: payload.weekStart,
        action: 'UPSERT_SLOT',
        changedByUserId: payload.userId,
        changedByDisplayName,
        dayOfWeek: payload.data?.dayOfWeek,
        mealType: payload.data?.mealType,
      });
      this.notifyPlanChanged(payload.householdId, payload.userId, changedByDisplayName, 'UPSERT_SLOT', {
        dayOfWeek: payload.data?.dayOfWeek,
        mealType: payload.data?.mealType,
        weekStart: payload.weekStart,
      });

      return result;
    });
  }

  @SubscribeMessage('weeklyPlans:removeWeekSlot')
  removeWeekSlot(@MessageBody() payload: WeeklyPlansRemoveWeekSlotPayload) {
    return wsRespond(async () => {
      const changedByDisplayName = await this.weeklyPlansService.getUserDisplayName(payload.userId);
      const result = await this.weeklyPlansService.removeWeekSlot(
        payload.userId,
        payload.householdId,
        payload.weekStart,
        payload.data,
      );

      if (!result) {
        return result;
      }

      this.server.emit('weeklyPlans:weekChanged', {
        householdId: payload.householdId,
        weekStart: payload.weekStart,
        action: 'REMOVE_SLOT',
        changedByUserId: payload.userId,
        changedByDisplayName,
        dayOfWeek: payload.data?.dayOfWeek,
        mealType: payload.data?.mealType,
      });
      this.notifyPlanChanged(payload.householdId, payload.userId, changedByDisplayName, 'REMOVE_SLOT', {
        dayOfWeek: payload.data?.dayOfWeek,
        mealType: payload.data?.mealType,
        weekStart: payload.weekStart,
      });

      return result;
    });
  }

  @SubscribeMessage('weeklyPlans:getSavedPlan')
  getSavedPlan(@MessageBody() payload: WeeklyPlansGetSavedPlanPayload) {
    return wsRespond(() =>
      this.weeklyPlansService.getSharedMealPlan(payload.userId, payload.householdId, payload.weekStart),
    );
  }

  @SubscribeMessage('weeklyPlans:saveSavedPlan')
  saveSavedPlan(@MessageBody() payload: WeeklyPlansSaveSavedPlanPayload) {
    return wsRespond(async () => {
      const changedByDisplayName = await this.weeklyPlansService.getUserDisplayName(payload.userId);

      const before = await this.weeklyPlansService.getSharedMealPlan(
        payload.userId,
        payload.householdId,
        payload.weekStart,
      );
      const beforeFingerprint = this.buildSavedPlanFingerprint(before);

      const result = await this.weeklyPlansService.saveSharedMealPlan(
        payload.userId,
        payload.householdId,
        payload.weekStart,
        payload.data,
      );
      const afterFingerprint = this.buildSavedPlanFingerprint(result);
      const changed = beforeFingerprint !== afterFingerprint;

      if (!changed) {
        return result;
      }

      this.server.emit('weeklyPlans:savedPlanChanged', {
        householdId: payload.householdId,
        weekStart: payload.weekStart,
        changedByUserId: payload.userId,
        changedByDisplayName,
        action: 'SAVE_PLAN',
      });
      this.server.emit('weeklyPlans:shoppingListChanged', {
        householdId: payload.householdId,
        weekStart: payload.weekStart,
      });
      this.notifyPlanChanged(payload.householdId, payload.userId, changedByDisplayName, 'SAVE_PLAN', {
        weekStart: payload.weekStart,
      });

      return result;
    });
  }

  @SubscribeMessage('weeklyPlans:clearWeekPlan')
  clearWeekPlan(@MessageBody() payload: WeeklyPlansClearWeekPlanPayload) {
    return wsRespond(async () => {
      const changedByDisplayName = await this.weeklyPlansService.getUserDisplayName(payload.userId);
      const result = await this.weeklyPlansService.clearWeekPlan(
        payload.userId,
        payload.householdId,
        payload.weekStart,
      );

      this.server.emit('weeklyPlans:weekChanged', {
        householdId: payload.householdId,
        weekStart: payload.weekStart,
        action: 'CLEAR_PLAN',
        changedByUserId: payload.userId,
        changedByDisplayName,
      });
      this.server.emit('weeklyPlans:savedPlanChanged', {
        householdId: payload.householdId,
        weekStart: payload.weekStart,
        changedByUserId: payload.userId,
        changedByDisplayName,
        action: 'CLEAR_PLAN',
      });
      this.server.emit('weeklyPlans:shoppingListChanged', {
        householdId: payload.householdId,
        weekStart: payload.weekStart,
      });
      this.notifyPlanChanged(payload.householdId, payload.userId, changedByDisplayName, 'CLEAR_PLAN', {
        weekStart: payload.weekStart,
      });

      return result;
    });
  }
}
