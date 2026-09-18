import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import {
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { WS_GATEWAY_OPTIONS } from '../common/ws-gateway-options';
import { validateWsPayload } from '../common/validate-dto';
import { wsRespond } from '../common/ws-response';
import type { AppSocket } from '../common/ws-socket';
import { actorId } from '../common/ws-socket';
import { broadcastToHousehold } from '../common/ws-rooms';
import { WeeklyPlansService } from './weekly-plans.service';
import { ShoppingListService } from './services/shopping-list.service';
import { UpdateShoppingItemCheckDto } from './dto/update-shopping-item-check.dto';
import { ApplyWeekPlanDto } from './dto/apply-week-plan.dto';
import { UpsertWeekSlotDto } from './dto/upsert-week-slot.dto';
import { RemoveWeekSlotDto } from './dto/remove-week-slot.dto';
import { SetMealEatenDto } from './dto/set-meal-eaten.dto';
import { Server, Socket } from 'socket.io';
import { NotificationsService } from '../notifications/notifications.service';
import { WsTelemetryService } from '../common/ws-telemetry.service';

/**
 * Koperty zdarzeń WS. Dekoratory są tu od Fazy 0 (krok 2) egzekwowane przez
 * `validateWsPayload` w każdym handlerze — whitelist WYCINA pola bez
 * dekoratora, więc każde pole, które handler czyta, musi mieć swój.
 * `data` dostaje tylko `@IsObject()` (bez `@ValidateNested`): zawartość
 * waliduje serwis przez `validateDto`, każde pole dokładnie raz, bez
 * zdublowanych `details`. `weekStart` to `@IsString()` — format i „czy to
 * poniedziałek" sprawdza `parseWeekStart` w serwisie.
 */
class WeeklyPlansHouseholdPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  @IsOptional()
  @IsString()
  userId?: string;

  @IsUUID()
  householdId: string;
}

/**
 * Koperta większości zdarzeń (getByWeek, getShoppingList,
 * getShoppingListState, deleteAllShoppingListArchives, getSavedPlan,
 * clearWeekPlan): gospodarstwo + tydzień.
 */
class WeeklyPlansHouseholdWeekPayload extends WeeklyPlansHouseholdPayload {
  @IsString()
  weekStart: string;
}

class WeeklyPlansArchiveShoppingListPayload extends WeeklyPlansHouseholdWeekPayload {
  @IsString()
  @MaxLength(64)
  weekLabel: string;
}

/** `selectShoppingListArchive` i `deleteShoppingListArchive`. */
class WeeklyPlansShoppingListArchivePayload extends WeeklyPlansHouseholdPayload {
  @IsUUID()
  archiveId: string;
}

class WeeklyPlansSetShoppingItemCheckedPayload extends WeeklyPlansHouseholdWeekPayload {
  @IsObject()
  data: UpdateShoppingItemCheckDto;
}

class WeeklyPlansUpsertWeekSlotPayload extends WeeklyPlansHouseholdWeekPayload {
  @IsObject()
  data: UpsertWeekSlotDto;
}

class WeeklyPlansBalancePayload extends WeeklyPlansHouseholdWeekPayload {
  /** Czyj bilans; pominięte = własny. */
  @IsOptional()
  @IsUUID()
  memberUserId?: string;
}

class WeeklyPlansApplyWeekPlanPayload extends WeeklyPlansHouseholdWeekPayload {
  @IsObject()
  data: ApplyWeekPlanDto;
}

class WeeklyPlansRemoveWeekSlotPayload extends WeeklyPlansHouseholdWeekPayload {
  @IsObject()
  data: RemoveWeekSlotDto;
}

class WeeklyPlansSetMealEatenPayload extends WeeklyPlansHouseholdWeekPayload {
  @IsObject()
  data: SetMealEatenDto;
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

  /**
   * Rozgłasza zapis całego tygodnia.
   *
   * Publiczne, bo od trybu propozycji tydzień zapisuje się także POZA
   * handlerem WS — na kliknięcie „Dodaj do planu", czyli z endpointu REST
   * asystenta. Bez tego drugi telefon w domu nie dowiadywał się o zmianie,
   * dopóki ktoś nie pociągnął listy w dół (dziś zapisy asystenta nie
   * rozgłaszają się wcale — to jest ta dziura).
   *
   * `nextChangeVersion` zostaje tutaj, żeby wersje szły z jednego licznika.
   */
  broadcastWeekApplied(input: {
    householdId: string;
    weekStart: string;
    changedByUserId: string;
    changedByDisplayName?: string | null;
  }): void {
    broadcastToHousehold(
      this.server,
      input.householdId,
      'weeklyPlans:weekChanged',
      {
        householdId: input.householdId,
        weekStart: input.weekStart,
        action: 'APPLY_WEEK',
        changedByUserId: input.changedByUserId,
        changedByDisplayName: input.changedByDisplayName ?? null,
        changeVersion: this.nextChangeVersion(),
      },
    );
    this.emitShoppingListChanged({
      householdId: input.householdId,
      weekStart: input.weekStart,
      action: 'APPLY_WEEK',
      changedByUserId: input.changedByUserId,
      changedByDisplayName: input.changedByDisplayName ?? null,
    });
  }

  /**
   * Odhaczenie „zjedzone" — rozgłoszenie bez pusha.
   *
   * Publiczne z tego samego powodu, co `broadcastWeekApplied`: to samo
   * odhaczenie robi dziś także asystent (`mark_meal_eaten`), a zmiana zrobiona
   * jego ręką ma dojechać do drugiego telefonu tak samo jak zrobiona palcem.
   * Bez tego kalendarz na drugim urządzeniu pokazywałby nieodhaczony posiłek
   * do następnego przeładowania.
   *
   * Push nie leci nigdy: to, co ktoś zjadł, nie zmienia planu ani listy,
   * a dzwonienie domownikom o czyimś śniadaniu jest szumem.
   */
  broadcastMealEaten(input: {
    householdId: string;
    weekStart: string;
    changedByUserId: string;
    dayOfWeek?: string | null;
    mealType?: string | null;
  }): void {
    broadcastToHousehold(
      this.server,
      input.householdId,
      'weeklyPlans:weekChanged',
      {
        householdId: input.householdId,
        weekStart: input.weekStart,
        action: 'SET_MEAL_EATEN',
        changedByUserId: input.changedByUserId,
        changedByDisplayName: null,
        dayOfWeek: input.dayOfWeek ?? undefined,
        mealType: input.mealType ?? undefined,
        changeVersion: this.nextChangeVersion(),
      },
    );
  }

  /**
   * Odhaczenie pozycji listy zakupów — rozgłoszenie plus bufor powiadomień.
   *
   * Jedno miejsce dla obu dróg (palec w aplikacji i `check_shopping_items`
   * asystenta), żeby nie dało się zmienić jednej i zapomnieć o drugiej.
   * Pojedynczy checkbox nigdy nie zamienia się w powiadomienie — bufor czeka,
   * aż ktoś skończy zakupy, i wysyła jedno „odhaczył 12 produktów".
   */
  broadcastShoppingItemChecked(input: {
    householdId: string;
    weekStart: string;
    changedByUserId: string;
    changedByDisplayName?: string | null;
    productKey: string;
    isChecked: boolean;
  }): void {
    this.emitShoppingListChanged({
      householdId: input.householdId,
      weekStart: input.weekStart,
      action: 'SET_ITEM_CHECKED',
      changedByUserId: input.changedByUserId,
      changedByDisplayName: input.changedByDisplayName ?? null,
      productKey: input.productKey,
      isChecked: input.isChecked,
    });
    this.notifyShoppingListChanged({
      householdId: input.householdId,
      changedByUserId: input.changedByUserId,
      changedByDisplayName: input.changedByDisplayName ?? null,
      action: 'SET_ITEM_CHECKED',
      isChecked: input.isChecked,
    });
  }

  @SubscribeMessage('weeklyPlans:getByWeek')
  getByWeek(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: WeeklyPlansHouseholdWeekPayload,
  ) {
    return wsRespond(async () => {
      // Kolejność jest ważna: najpierw tożsamość, potem koperta — anonimowy
      // socket ma dostać UNAUTHORIZED, nie VALIDATION_ERROR (pilnuje tego
      // `ws-handlers-auth.spec.ts`). Tak samo w każdym handlerze niżej.
      const userId = actorId(client, payload);
      await validateWsPayload(WeeklyPlansHouseholdWeekPayload, payload);
      return this.weeklyPlansService.getByHouseholdAndWeek(
        userId,
        payload.householdId,
        payload.weekStart,
      );
    });
  }

  @SubscribeMessage('weeklyPlans:getShoppingList')
  getShoppingList(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: WeeklyPlansHouseholdWeekPayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      await validateWsPayload(WeeklyPlansHouseholdWeekPayload, payload);
      return this.shoppingListService.getShoppingList(
        userId,
        payload.householdId,
        payload.weekStart,
      );
    });
  }

  @SubscribeMessage('weeklyPlans:getShoppingListState')
  getShoppingListState(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: WeeklyPlansHouseholdWeekPayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      await validateWsPayload(WeeklyPlansHouseholdWeekPayload, payload);
      return this.shoppingListService.getShoppingListState(
        userId,
        payload.householdId,
        payload.weekStart,
      );
    });
  }

  @SubscribeMessage('weeklyPlans:archiveShoppingList')
  archiveShoppingList(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: WeeklyPlansArchiveShoppingListPayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      await validateWsPayload(WeeklyPlansArchiveShoppingListPayload, payload);
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
    @MessageBody() payload: WeeklyPlansShoppingListArchivePayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      await validateWsPayload(WeeklyPlansShoppingListArchivePayload, payload);
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
    @MessageBody() payload: WeeklyPlansShoppingListArchivePayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      await validateWsPayload(WeeklyPlansShoppingListArchivePayload, payload);
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
    @MessageBody() payload: WeeklyPlansHouseholdWeekPayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      await validateWsPayload(WeeklyPlansHouseholdWeekPayload, payload);
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
      await validateWsPayload(
        WeeklyPlansSetShoppingItemCheckedPayload,
        payload,
      );
      const changedByDisplayName =
        await this.weeklyPlansService.getUserDisplayName(userId);
      const result = await this.shoppingListService.setShoppingItemChecked(
        userId,
        payload.householdId,
        payload.weekStart,
        payload.data,
      );

      this.broadcastShoppingItemChecked({
        householdId: payload.householdId,
        weekStart: payload.weekStart,
        changedByUserId: userId,
        changedByDisplayName,
        productKey: payload.data.productKey,
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
      await validateWsPayload(WeeklyPlansUpsertWeekSlotPayload, payload);
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

  /**
   * Cały tydzień naraz. JEDEN broadcast, nie 21 — i żadnego, gdy nic nie
   * weszło (`dryRun` albo naruszenia): klient nie ma powodu odświeżać planu,
   * który się nie zmienił.
   */
  /**
   * Bilans tygodnia dla domownika. Czysty odczyt — bez broadcastu i bez
   * zapisu; asystent woła go przed pokazaniem propozycji planu.
   */
  @SubscribeMessage('weeklyPlans:balance')
  balance(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: WeeklyPlansBalancePayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      const envelope = await validateWsPayload(
        WeeklyPlansBalancePayload,
        payload,
      );
      return this.weeklyPlansService.weeklyBalance(
        userId,
        envelope.householdId,
        envelope.weekStart,
        envelope.memberUserId,
      );
    });
  }

  @SubscribeMessage('weeklyPlans:applyWeekPlan')
  applyWeekPlan(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: WeeklyPlansApplyWeekPlanPayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      await validateWsPayload(WeeklyPlansApplyWeekPlanPayload, payload);
      const changedByDisplayName =
        await this.weeklyPlansService.getUserDisplayName(userId);
      const result = await this.weeklyPlansService.applyWeekPlan(
        userId,
        payload.householdId,
        payload.weekStart,
        payload.data,
      );

      if (!result.applied) return result;

      this.broadcastWeekApplied({
        householdId: payload.householdId,
        weekStart: payload.weekStart,
        changedByUserId: userId,
        changedByDisplayName,
      });
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
      await validateWsPayload(WeeklyPlansRemoveWeekSlotPayload, payload);
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
      await validateWsPayload(WeeklyPlansSetMealEatenPayload, payload);
      const result = await this.weeklyPlansService.setMealEaten(
        userId,
        payload.householdId,
        payload.weekStart,
        payload.data,
      );

      this.broadcastMealEaten({
        householdId: payload.householdId,
        weekStart: payload.weekStart,
        changedByUserId: userId,
        dayOfWeek: payload.data?.dayOfWeek,
        mealType: payload.data?.mealType,
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
   * Tożsamość nadal jest wymagana (`actorId`) — anonimowy socket dostaje
   * `UNAUTHORIZED` jak z każdego innego handlera, mimo że odpowiedź jest stała.
   *
   * TODO(WP-03): usunąć, gdy nowa aplikacja będzie na (prawie) wszystkich
   * telefonach.
   */
  @SubscribeMessage('weeklyPlans:getSavedPlan')
  getSavedPlan(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: WeeklyPlansHouseholdWeekPayload,
  ) {
    return wsRespond(async () => {
      actorId(client, payload);
      // Koperta walidowana mimo stałej odpowiedzi: `payload.weekStart` wraca
      // do klienta, a bez bramki `payload === undefined` dawał TypeError.
      await validateWsPayload(WeeklyPlansHouseholdWeekPayload, payload);
      return {
        weekStart: payload.weekStart,
        items: [] as never[],
      };
    });
  }

  @SubscribeMessage('weeklyPlans:clearWeekPlan')
  clearWeekPlan(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: WeeklyPlansHouseholdWeekPayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      await validateWsPayload(WeeklyPlansHouseholdWeekPayload, payload);
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
