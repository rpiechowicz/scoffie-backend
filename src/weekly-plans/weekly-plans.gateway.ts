import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { WS_GATEWAY_OPTIONS } from '../common/ws-gateway-options';
import { wsRespond } from '../common/ws-response';
import type { AppSocket } from '../common/ws-socket';
import { actorId } from '../common/ws-socket';
import { broadcastToHousehold } from '../common/ws-rooms';
import { WeeklyPlansService } from './weekly-plans.service';
import { ShoppingListService } from './services/shopping-list.service';
import { UpdateShoppingItemCheckDto } from './dto/update-shopping-item-check.dto';
import { UpsertWeekSlotDto } from './dto/upsert-week-slot.dto';
import { RemoveWeekSlotDto } from './dto/remove-week-slot.dto';
import { SetMealEatenDto } from './dto/set-meal-eaten.dto';
import { Server, Socket } from 'socket.io';
import { NotificationsService } from '../notifications/notifications.service';
import { WsTelemetryService } from '../common/ws-telemetry.service';

class WeeklyPlansGetByWeekPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
  householdId: string;
  weekStart: string;
}

class WeeklyPlansGetShoppingListPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
  householdId: string;
  weekStart: string;
}

class WeeklyPlansGetShoppingListStatePayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
  householdId: string;
  weekStart: string;
}

class WeeklyPlansArchiveShoppingListPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
  householdId: string;
  weekStart: string;
  weekLabel: string;
}

class WeeklyPlansSelectShoppingListArchivePayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
  householdId: string;
  archiveId: string;
}

class WeeklyPlansDeleteShoppingListArchivePayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
  householdId: string;
  archiveId: string;
}

class WeeklyPlansDeleteAllShoppingListArchivesPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
  householdId: string;
  weekStart: string;
}

class WeeklyPlansSetShoppingItemCheckedPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
  householdId: string;
  weekStart: string;
  data: UpdateShoppingItemCheckDto;
}

class WeeklyPlansUpsertWeekSlotPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
  householdId: string;
  weekStart: string;
  data: UpsertWeekSlotDto;
}

class WeeklyPlansRemoveWeekSlotPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
  householdId: string;
  weekStart: string;
  data: RemoveWeekSlotDto;
}

class WeeklyPlansSetMealEatenPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
  householdId: string;
  weekStart: string;
  data: SetMealEatenDto;
}

/**
 * DEPRECATED — patrz `getSavedPlan`. Do usunięcia razem z handlerem.
 */
class WeeklyPlansGetSavedPlanPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
  householdId: string;
  weekStart: string;
}

class WeeklyPlansClearWeekPlanPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
  householdId: string;
  weekStart: string;
}

@WebSocketGateway(WS_GATEWAY_OPTIONS)
export class WeeklyPlansGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  private server: Server;

  constructor(
    private readonly weeklyPlansService: WeeklyPlansService,
    private readonly shoppingListService: ShoppingListService,
    private readonly notificationsService: NotificationsService,
    private readonly wsTelemetry: WsTelemetryService,
  ) {}

  handleConnection(_client: Socket) {
    this.wsTelemetry.onConnect(WeeklyPlansGateway.name);
  }

  handleDisconnect(_client: Socket) {
    this.wsTelemetry.onDisconnect(WeeklyPlansGateway.name);
  }

  /**
   * Dokłada zmianę do paczki powiadomień. Nazwa mówi „notify", ale nic nie
   * wychodzi natychmiast — `NotificationsService` zbiera zdarzenia i wysyła
   * jedno podsumowanie po tym, jak autor przestanie klikać. To jest miejsce, w
   * którym „jeden push na kratkę planu" zamienia się w „jeden push na sesję".
   */
  private notifyPlanChanged(
    householdId: string,
    changedByUserId: string,
    changedByDisplayName: string | null | undefined,
    action: string,
    context?: {
      dayOfWeek?: string | null;
      mealType?: string | null;
      weekStart?: string | null;
    },
  ): void {
    this.notificationsService.enqueueWeeklyPlanChange({
      householdId,
      changedByUserId,
      changedByDisplayName,
      action,
      context,
    });
  }

  /**
   * To samo dla listy zakupów. Dotąd lista nie wysyłała pushy w ogóle —
   * powiadomienie o odhaczonym produkcie składał sobie sam klient iOS, więc
   * docierało wyłącznie do telefonu z uruchomioną aplikacją i mijało się z
   * celem. Zbiorczo („odhaczył 12 produktów") niesie realną informację:
   * zakupy są zrobione.
   */
  private notifyShoppingListChanged(input: {
    householdId: string;
    changedByUserId?: string | null;
    changedByDisplayName?: string | null;
    action: string;
    isChecked?: boolean | null;
  }): void {
    if (!input.changedByUserId) {
      return;
    }
    this.notificationsService.enqueueShoppingListChange({
      householdId: input.householdId,
      changedByUserId: input.changedByUserId,
      changedByDisplayName: input.changedByDisplayName,
      action: input.action,
      isChecked: input.isChecked,
    });
  }

  private emitShoppingListChanged(input: {
    householdId: string;
    weekStart: string;
    action: string;
    changedByUserId?: string | null;
    changedByDisplayName?: string | null;
    productKey?: string | null;
    isChecked?: boolean | null;
  }): void {
    const changeVersion = this.nextChangeVersion();
    broadcastToHousehold(
      this.server,
      input.householdId,
      'weeklyPlans:shoppingListChanged',
      {
        householdId: input.householdId,
        weekStart: input.weekStart,
        action: input.action,
        changedByUserId: input.changedByUserId ?? null,
        changedByDisplayName: input.changedByDisplayName ?? null,
        productKey: input.productKey ?? null,
        isChecked: input.isChecked ?? null,
        changeVersion,
      },
    );
  }

  private nextChangeVersion(): number {
    return Date.now();
  }

  @SubscribeMessage('weeklyPlans:getByWeek')
  getByWeek(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: WeeklyPlansGetByWeekPayload,
  ) {
    return wsRespond(() =>
      this.weeklyPlansService.getByHouseholdAndWeek(
        actorId(client, payload),
        payload.householdId,
        payload.weekStart,
      ),
    );
  }

  @SubscribeMessage('weeklyPlans:getShoppingList')
  getShoppingList(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: WeeklyPlansGetShoppingListPayload,
  ) {
    return wsRespond(() =>
      this.shoppingListService.getShoppingList(
        actorId(client, payload),
        payload.householdId,
        payload.weekStart,
      ),
    );
  }

  @SubscribeMessage('weeklyPlans:getShoppingListState')
  getShoppingListState(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: WeeklyPlansGetShoppingListStatePayload,
  ) {
    return wsRespond(() =>
      this.shoppingListService.getShoppingListState(
        actorId(client, payload),
        payload.householdId,
        payload.weekStart,
      ),
    );
  }

  @SubscribeMessage('weeklyPlans:archiveShoppingList')
  archiveShoppingList(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: WeeklyPlansArchiveShoppingListPayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      const changedByDisplayName =
        await this.weeklyPlansService.getUserDisplayName(userId);
      const result = await this.shoppingListService.archiveShoppingList(
        userId,
        payload.householdId,
        payload.weekStart,
        payload.weekLabel,
      );

      this.emitShoppingListChanged({
        householdId: payload.householdId,
        weekStart: payload.weekStart,
        action: 'ARCHIVE_LIST',
        changedByUserId: userId,
        changedByDisplayName,
      });
      this.notifyShoppingListChanged({
        householdId: payload.householdId,
        changedByUserId: userId,
        changedByDisplayName,
        action: 'ARCHIVE_LIST',
      });

      return result;
    });
  }

  @SubscribeMessage('weeklyPlans:selectShoppingListArchive')
  selectShoppingListArchive(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: WeeklyPlansSelectShoppingListArchivePayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      const changedByDisplayName =
        await this.weeklyPlansService.getUserDisplayName(userId);
      const result = await this.shoppingListService.selectShoppingListArchive(
        userId,
        payload.householdId,
        payload.archiveId,
      );

      this.emitShoppingListChanged({
        householdId: payload.householdId,
        weekStart: result.weekStart,
        action: 'SELECT_ARCHIVE',
        changedByUserId: userId,
        changedByDisplayName,
      });

      return result;
    });
  }

  @SubscribeMessage('weeklyPlans:deleteShoppingListArchive')
  deleteShoppingListArchive(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: WeeklyPlansDeleteShoppingListArchivePayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      const changedByDisplayName =
        await this.weeklyPlansService.getUserDisplayName(userId);
      const result = await this.shoppingListService.deleteShoppingListArchive(
        userId,
        payload.householdId,
        payload.archiveId,
      );

      this.emitShoppingListChanged({
        householdId: payload.householdId,
        weekStart: result.weekStart,
        action: 'DELETE_ARCHIVE',
        changedByUserId: userId,
        changedByDisplayName,
      });

      return result;
    });
  }

  @SubscribeMessage('weeklyPlans:deleteAllShoppingListArchives')
  deleteAllShoppingListArchives(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: WeeklyPlansDeleteAllShoppingListArchivesPayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      const changedByDisplayName =
        await this.weeklyPlansService.getUserDisplayName(userId);
      const result =
        await this.shoppingListService.deleteAllShoppingListArchives(
          userId,
          payload.householdId,
          payload.weekStart,
        );

      this.emitShoppingListChanged({
        householdId: payload.householdId,
        weekStart: payload.weekStart,
        action: 'DELETE_ALL_ARCHIVES',
        changedByUserId: userId,
        changedByDisplayName,
      });

      return result;
    });
  }

  @SubscribeMessage('weeklyPlans:setShoppingItemChecked')
  setShoppingItemChecked(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: WeeklyPlansSetShoppingItemCheckedPayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      const changedByDisplayName =
        await this.weeklyPlansService.getUserDisplayName(userId);
      const result = await this.shoppingListService.setShoppingItemChecked(
        userId,
        payload.householdId,
        payload.weekStart,
        payload.data,
      );

      this.emitShoppingListChanged({
        householdId: payload.householdId,
        weekStart: payload.weekStart,
        action: 'SET_ITEM_CHECKED',
        changedByUserId: userId,
        changedByDisplayName,
        productKey: payload.data.productKey,
        isChecked: payload.data.isChecked,
      });
      // Pojedynczy checkbox nigdy nie zamienia się w powiadomienie — bufor
      // czeka, aż ktoś skończy zakupy, i wysyła jedno „odhaczył 12 produktów".
      this.notifyShoppingListChanged({
        householdId: payload.householdId,
        changedByUserId: userId,
        changedByDisplayName,
        action: 'SET_ITEM_CHECKED',
        isChecked: payload.data.isChecked,
      });

      return result;
    });
  }

  @SubscribeMessage('weeklyPlans:upsertWeekSlot')
  upsertWeekSlot(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: WeeklyPlansUpsertWeekSlotPayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      const changedByDisplayName =
        await this.weeklyPlansService.getUserDisplayName(userId);
      const result = await this.weeklyPlansService.upsertWeekSlot(
        userId,
        payload.householdId,
        payload.weekStart,
        payload.data,
      );

      const changeVersion = this.nextChangeVersion();
      broadcastToHousehold(
        this.server,
        payload.householdId,
        'weeklyPlans:weekChanged',
        {
          householdId: payload.householdId,
          weekStart: payload.weekStart,
          action: 'UPSERT_SLOT',
          changedByUserId: userId,
          changedByDisplayName,
          dayOfWeek: payload.data?.dayOfWeek,
          mealType: payload.data?.mealType,
          changeVersion,
        },
      );
      this.emitShoppingListChanged({
        householdId: payload.householdId,
        weekStart: payload.weekStart,
        action: 'UPSERT_SLOT',
        changedByUserId: userId,
        changedByDisplayName,
      });
      // Powiadamiamy tylko o NOWYM daniu w slocie. Trafienie w istniejący item
      // znaczy, że przepis się nie zmienił — ruszył stepper porcji albo chipy
      // audytorium, a to są ustawienia własne, nie wiadomość dla domownika.
      // Podmiana (`replaceRecipeId`) to też nowe danie: stary wariant zniknął w
      // tej samej transakcji, więc idzie JEDEN broadcast i JEDEN push, nie
      // para REMOVE_SLOT + UPSERT_SLOT jak przy dawnym dwukrokowym zapisie.
      // Akcja zostaje `UPSERT_SLOT` — iOS zna tylko te nazwy, a nieznana
      // zgasiłaby powiadomienie zamiast je opisać.
      if (
        result?.changeKind === 'CREATED' ||
        result?.changeKind === 'REPLACED'
      ) {
        this.notifyPlanChanged(
          payload.householdId,
          userId,
          changedByDisplayName,
          'UPSERT_SLOT',
          {
            dayOfWeek: payload.data?.dayOfWeek,
            mealType: payload.data?.mealType,
            weekStart: payload.weekStart,
          },
        );
      }

      return result;
    });
  }

  @SubscribeMessage('weeklyPlans:removeWeekSlot')
  removeWeekSlot(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: WeeklyPlansRemoveWeekSlotPayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      const changedByDisplayName =
        await this.weeklyPlansService.getUserDisplayName(userId);
      const result = await this.weeklyPlansService.removeWeekSlot(
        userId,
        payload.householdId,
        payload.weekStart,
        payload.data,
      );

      if (!result) {
        return result;
      }

      const changeVersion = this.nextChangeVersion();
      broadcastToHousehold(
        this.server,
        payload.householdId,
        'weeklyPlans:weekChanged',
        {
          householdId: payload.householdId,
          weekStart: payload.weekStart,
          action: 'REMOVE_SLOT',
          changedByUserId: userId,
          changedByDisplayName,
          dayOfWeek: payload.data?.dayOfWeek,
          mealType: payload.data?.mealType,
          changeVersion,
        },
      );
      this.emitShoppingListChanged({
        householdId: payload.householdId,
        weekStart: payload.weekStart,
        action: 'REMOVE_SLOT',
        changedByUserId: userId,
        changedByDisplayName,
      });
      this.notifyPlanChanged(
        payload.householdId,
        userId,
        changedByDisplayName,
        'REMOVE_SLOT',
        {
          dayOfWeek: payload.data?.dayOfWeek,
          mealType: payload.data?.mealType,
          weekStart: payload.weekStart,
        },
      );

      return result;
    });
  }

  @SubscribeMessage('weeklyPlans:setMealEaten')
  setMealEaten(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: WeeklyPlansSetMealEatenPayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      const result = await this.weeklyPlansService.setMealEaten(
        userId,
        payload.householdId,
        payload.weekStart,
        payload.data,
      );

      // Broadcast so a second device of the same user redraws, but no push
      // notification and no shopping-list invalidation: logging what you ate
      // changes neither the plan nor the list, and nagging the household
      // about someone's breakfast would be noise.
      const changeVersion = this.nextChangeVersion();
      broadcastToHousehold(
        this.server,
        payload.householdId,
        'weeklyPlans:weekChanged',
        {
          householdId: payload.householdId,
          weekStart: payload.weekStart,
          action: 'SET_MEAL_EATEN',
          changedByUserId: userId,
          changedByDisplayName: null,
          dayOfWeek: payload.data?.dayOfWeek,
          mealType: payload.data?.mealType,
          changeVersion,
        },
      );

      return result;
    });
  }

  /**
   * DEPRECATED — pula tygodniowa (`SharedMealPlan`) została wycofana; źródłem
   * prawdy jest wyłącznie `PlanItem` (Plan v2). Handler zostaje na JEDNO
   * wydanie i odpowiada pustą pulą, bo aplikacja ze sklepu woła go w
   * `CalendarView.task` PRZED wczytaniem tygodnia: brak handlera to trzy
   * nieudane próby ACK × 6 s, czyli ~18 s pustego kalendarza na każdym
   * nieaktualizowanym telefonie przy każdej zmianie tygodnia. Nie dotyka bazy.
   *
   * Kształt odpowiedzi odpowiada `BackendSharedMealPlanDTO` w iOS
   * (`weekStart`, `items`), więc stary klient dekoduje ją bez błędu i renderuje
   * pustą pulę — czyli dokładnie to, co renderował zawsze, bo żaden widok jej
   * nie czyta.
   *
   * Tożsamość nadal jest wymagana (`actorId`) — anonimowy socket dostaje
   * `UNAUTHORIZED` jak z każdego innego handlera, mimo że odpowiedź jest stała.
   *
   * TODO(WP-03): usunąć razem z `WeeklyPlansGetSavedPlanPayload`, gdy nowa
   * aplikacja będzie na (prawie) wszystkich telefonach.
   */
  @SubscribeMessage('weeklyPlans:getSavedPlan')
  getSavedPlan(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: WeeklyPlansGetSavedPlanPayload,
  ) {
    return wsRespond(() => {
      actorId(client, payload);
      return Promise.resolve({
        weekStart: payload.weekStart,
        items: [] as never[],
      });
    });
  }

  @SubscribeMessage('weeklyPlans:clearWeekPlan')
  clearWeekPlan(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: WeeklyPlansClearWeekPlanPayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      const changedByDisplayName =
        await this.weeklyPlansService.getUserDisplayName(userId);
      const result = await this.weeklyPlansService.clearWeekPlan(
        userId,
        payload.householdId,
        payload.weekStart,
      );

      const changeVersion = this.nextChangeVersion();
      broadcastToHousehold(
        this.server,
        payload.householdId,
        'weeklyPlans:weekChanged',
        {
          householdId: payload.householdId,
          weekStart: payload.weekStart,
          action: 'CLEAR_PLAN',
          changedByUserId: userId,
          changedByDisplayName,
          changeVersion,
        },
      );
      this.emitShoppingListChanged({
        householdId: payload.householdId,
        weekStart: payload.weekStart,
        action: 'CLEAR_PLAN',
        changedByUserId: userId,
        changedByDisplayName,
      });
      this.notifyPlanChanged(
        payload.householdId,
        userId,
        changedByDisplayName,
        'CLEAR_PLAN',
        {
          weekStart: payload.weekStart,
        },
      );

      return result;
    });
  }
}
