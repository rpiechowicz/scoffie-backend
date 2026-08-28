import {
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { WS_GATEWAY_OPTIONS } from '../common/ws-gateway-options';
import { wsRespond } from '../common/ws-response';
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
  userId: string;
  householdId: string;
  weekStart: string;
}

class WeeklyPlansGetShoppingListPayload {
  userId: string;
  householdId: string;
  weekStart: string;
}

class WeeklyPlansGetShoppingListStatePayload {
  userId: string;
  householdId: string;
  weekStart: string;
}

class WeeklyPlansArchiveShoppingListPayload {
  userId: string;
  householdId: string;
  weekStart: string;
  weekLabel: string;
}

class WeeklyPlansSelectShoppingListArchivePayload {
  userId: string;
  householdId: string;
  archiveId: string;
}

class WeeklyPlansDeleteShoppingListArchivePayload {
  userId: string;
  householdId: string;
  archiveId: string;
}

class WeeklyPlansDeleteAllShoppingListArchivesPayload {
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

class WeeklyPlansSetMealEatenPayload {
  userId: string;
  householdId: string;
  weekStart: string;
  data: SetMealEatenDto;
}

/**
 * DEPRECATED — patrz `getSavedPlan`. Do usunięcia razem z handlerem.
 */
class WeeklyPlansGetSavedPlanPayload {
  userId: string;
  householdId: string;
  weekStart: string;
}

class WeeklyPlansClearWeekPlanPayload {
  userId: string;
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
    this.server.emit('weeklyPlans:shoppingListChanged', {
      householdId: input.householdId,
      weekStart: input.weekStart,
      action: input.action,
      changedByUserId: input.changedByUserId ?? null,
      changedByDisplayName: input.changedByDisplayName ?? null,
      productKey: input.productKey ?? null,
      isChecked: input.isChecked ?? null,
      changeVersion,
    });
  }

  private nextChangeVersion(): number {
    return Date.now();
  }

  @SubscribeMessage('weeklyPlans:getByWeek')
  getByWeek(@MessageBody() payload: WeeklyPlansGetByWeekPayload) {
    return wsRespond(() =>
      this.weeklyPlansService.getByHouseholdAndWeek(
        payload.userId,
        payload.householdId,
        payload.weekStart,
      ),
    );
  }

  @SubscribeMessage('weeklyPlans:getShoppingList')
  getShoppingList(@MessageBody() payload: WeeklyPlansGetShoppingListPayload) {
    return wsRespond(() =>
      this.shoppingListService.getShoppingList(
        payload.userId,
        payload.householdId,
        payload.weekStart,
      ),
    );
  }

  @SubscribeMessage('weeklyPlans:getShoppingListState')
  getShoppingListState(
    @MessageBody() payload: WeeklyPlansGetShoppingListStatePayload,
  ) {
    return wsRespond(() =>
      this.shoppingListService.getShoppingListState(
        payload.userId,
        payload.householdId,
        payload.weekStart,
      ),
    );
  }

  @SubscribeMessage('weeklyPlans:archiveShoppingList')
  archiveShoppingList(
    @MessageBody() payload: WeeklyPlansArchiveShoppingListPayload,
  ) {
    return wsRespond(async () => {
      const changedByDisplayName =
        await this.weeklyPlansService.getUserDisplayName(payload.userId);
      const result = await this.shoppingListService.archiveShoppingList(
        payload.userId,
        payload.householdId,
        payload.weekStart,
        payload.weekLabel,
      );

      this.emitShoppingListChanged({
        householdId: payload.householdId,
        weekStart: payload.weekStart,
        action: 'ARCHIVE_LIST',
        changedByUserId: payload.userId,
        changedByDisplayName,
      });
      this.notifyShoppingListChanged({
        householdId: payload.householdId,
        changedByUserId: payload.userId,
        changedByDisplayName,
        action: 'ARCHIVE_LIST',
      });

      return result;
    });
  }

  @SubscribeMessage('weeklyPlans:selectShoppingListArchive')
  selectShoppingListArchive(
    @MessageBody() payload: WeeklyPlansSelectShoppingListArchivePayload,
  ) {
    return wsRespond(async () => {
      const changedByDisplayName =
        await this.weeklyPlansService.getUserDisplayName(payload.userId);
      const result = await this.shoppingListService.selectShoppingListArchive(
        payload.userId,
        payload.householdId,
        payload.archiveId,
      );

      this.emitShoppingListChanged({
        householdId: payload.householdId,
        weekStart: result.weekStart,
        action: 'SELECT_ARCHIVE',
        changedByUserId: payload.userId,
        changedByDisplayName,
      });

      return result;
    });
  }

  @SubscribeMessage('weeklyPlans:deleteShoppingListArchive')
  deleteShoppingListArchive(
    @MessageBody() payload: WeeklyPlansDeleteShoppingListArchivePayload,
  ) {
    return wsRespond(async () => {
      const changedByDisplayName =
        await this.weeklyPlansService.getUserDisplayName(payload.userId);
      const result = await this.shoppingListService.deleteShoppingListArchive(
        payload.userId,
        payload.householdId,
        payload.archiveId,
      );

      this.emitShoppingListChanged({
        householdId: payload.householdId,
        weekStart: result.weekStart,
        action: 'DELETE_ARCHIVE',
        changedByUserId: payload.userId,
        changedByDisplayName,
      });

      return result;
    });
  }

  @SubscribeMessage('weeklyPlans:deleteAllShoppingListArchives')
  deleteAllShoppingListArchives(
    @MessageBody() payload: WeeklyPlansDeleteAllShoppingListArchivesPayload,
  ) {
    return wsRespond(async () => {
      const changedByDisplayName =
        await this.weeklyPlansService.getUserDisplayName(payload.userId);
      const result =
        await this.shoppingListService.deleteAllShoppingListArchives(
          payload.userId,
          payload.householdId,
          payload.weekStart,
        );

      this.emitShoppingListChanged({
        householdId: payload.householdId,
        weekStart: payload.weekStart,
        action: 'DELETE_ALL_ARCHIVES',
        changedByUserId: payload.userId,
        changedByDisplayName,
      });

      return result;
    });
  }

  @SubscribeMessage('weeklyPlans:setShoppingItemChecked')
  setShoppingItemChecked(
    @MessageBody() payload: WeeklyPlansSetShoppingItemCheckedPayload,
  ) {
    return wsRespond(async () => {
      const changedByDisplayName =
        await this.weeklyPlansService.getUserDisplayName(payload.userId);
      const result = await this.shoppingListService.setShoppingItemChecked(
        payload.userId,
        payload.householdId,
        payload.weekStart,
        payload.data,
      );

      this.emitShoppingListChanged({
        householdId: payload.householdId,
        weekStart: payload.weekStart,
        action: 'SET_ITEM_CHECKED',
        changedByUserId: payload.userId,
        changedByDisplayName,
        productKey: payload.data.productKey,
        isChecked: payload.data.isChecked,
      });
      // Pojedynczy checkbox nigdy nie zamienia się w powiadomienie — bufor
      // czeka, aż ktoś skończy zakupy, i wysyła jedno „odhaczył 12 produktów".
      this.notifyShoppingListChanged({
        householdId: payload.householdId,
        changedByUserId: payload.userId,
        changedByDisplayName,
        action: 'SET_ITEM_CHECKED',
        isChecked: payload.data.isChecked,
      });

      return result;
    });
  }

  @SubscribeMessage('weeklyPlans:upsertWeekSlot')
  upsertWeekSlot(@MessageBody() payload: WeeklyPlansUpsertWeekSlotPayload) {
    return wsRespond(async () => {
      const changedByDisplayName =
        await this.weeklyPlansService.getUserDisplayName(payload.userId);
      const result = await this.weeklyPlansService.upsertWeekSlot(
        payload.userId,
        payload.householdId,
        payload.weekStart,
        payload.data,
      );

      const changeVersion = this.nextChangeVersion();
      this.server.emit('weeklyPlans:weekChanged', {
        householdId: payload.householdId,
        weekStart: payload.weekStart,
        action: 'UPSERT_SLOT',
        changedByUserId: payload.userId,
        changedByDisplayName,
        dayOfWeek: payload.data?.dayOfWeek,
        mealType: payload.data?.mealType,
        changeVersion,
      });
      this.emitShoppingListChanged({
        householdId: payload.householdId,
        weekStart: payload.weekStart,
        action: 'UPSERT_SLOT',
        changedByUserId: payload.userId,
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
          payload.userId,
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
  removeWeekSlot(@MessageBody() payload: WeeklyPlansRemoveWeekSlotPayload) {
    return wsRespond(async () => {
      const changedByDisplayName =
        await this.weeklyPlansService.getUserDisplayName(payload.userId);
      const result = await this.weeklyPlansService.removeWeekSlot(
        payload.userId,
        payload.householdId,
        payload.weekStart,
        payload.data,
      );

      if (!result) {
        return result;
      }

      const changeVersion = this.nextChangeVersion();
      this.server.emit('weeklyPlans:weekChanged', {
        householdId: payload.householdId,
        weekStart: payload.weekStart,
        action: 'REMOVE_SLOT',
        changedByUserId: payload.userId,
        changedByDisplayName,
        dayOfWeek: payload.data?.dayOfWeek,
        mealType: payload.data?.mealType,
        changeVersion,
      });
      this.emitShoppingListChanged({
        householdId: payload.householdId,
        weekStart: payload.weekStart,
        action: 'REMOVE_SLOT',
        changedByUserId: payload.userId,
        changedByDisplayName,
      });
      this.notifyPlanChanged(
        payload.householdId,
        payload.userId,
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
  setMealEaten(@MessageBody() payload: WeeklyPlansSetMealEatenPayload) {
    return wsRespond(async () => {
      const result = await this.weeklyPlansService.setMealEaten(
        payload.userId,
        payload.householdId,
        payload.weekStart,
        payload.data,
      );

      // Broadcast so a second device of the same user redraws, but no push
      // notification and no shopping-list invalidation: logging what you ate
      // changes neither the plan nor the list, and nagging the household
      // about someone's breakfast would be noise.
      const changeVersion = this.nextChangeVersion();
      this.server.emit('weeklyPlans:weekChanged', {
        householdId: payload.householdId,
        weekStart: payload.weekStart,
        action: 'SET_MEAL_EATEN',
        changedByUserId: payload.userId,
        changedByDisplayName: null,
        dayOfWeek: payload.data?.dayOfWeek,
        mealType: payload.data?.mealType,
        changeVersion,
      });

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
   * TODO(WP-03): usunąć razem z `WeeklyPlansGetSavedPlanPayload`, gdy nowa
   * aplikacja będzie na (prawie) wszystkich telefonach.
   */
  @SubscribeMessage('weeklyPlans:getSavedPlan')
  getSavedPlan(@MessageBody() payload: WeeklyPlansGetSavedPlanPayload) {
    return wsRespond(() =>
      Promise.resolve({
        weekStart: payload.weekStart,
        items: [] as never[],
      }),
    );
  }

  @SubscribeMessage('weeklyPlans:clearWeekPlan')
  clearWeekPlan(@MessageBody() payload: WeeklyPlansClearWeekPlanPayload) {
    return wsRespond(async () => {
      const changedByDisplayName =
        await this.weeklyPlansService.getUserDisplayName(payload.userId);
      const result = await this.weeklyPlansService.clearWeekPlan(
        payload.userId,
        payload.householdId,
        payload.weekStart,
      );

      const changeVersion = this.nextChangeVersion();
      this.server.emit('weeklyPlans:weekChanged', {
        householdId: payload.householdId,
        weekStart: payload.weekStart,
        action: 'CLEAR_PLAN',
        changedByUserId: payload.userId,
        changedByDisplayName,
        changeVersion,
      });
      this.emitShoppingListChanged({
        householdId: payload.householdId,
        weekStart: payload.weekStart,
        action: 'CLEAR_PLAN',
        changedByUserId: payload.userId,
        changedByDisplayName,
      });
      this.notifyPlanChanged(
        payload.householdId,
        payload.userId,
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
