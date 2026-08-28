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
import {
  broadcastToHousehold,
  joinHousehold,
  leaveHousehold,
} from '../common/ws-rooms';
import { HouseholdsService } from './households.service';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { CreateHouseholdDto } from './dto/create-household.dto';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { UpdateHouseholdDto } from './dto/update-household.dto';
import { UpdateHouseholdMealTypesDto } from './dto/update-meal-types.dto';
import { UpdateHouseholdMealTimesDto } from './dto/update-meal-times.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { Server, Socket } from 'socket.io';
import { WsTelemetryService } from '../common/ws-telemetry.service';
import { NotificationsService } from '../notifications/notifications.service';

class HouseholdsUserPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
}

class HouseholdsFindByIdPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
  id: string;
}

class HouseholdsCreatePayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
  data: CreateHouseholdDto;
}

class HouseholdsCreateInvitationPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
  householdId: string;
  data: CreateInvitationDto;
}

class HouseholdsAcceptInvitationPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
  data: AcceptInvitationDto;
}

class HouseholdsPreviewInvitationPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
  data: AcceptInvitationDto;
}

class HouseholdsDeclineInvitationPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
  data: AcceptInvitationDto;
}

class HouseholdsUpdateNamePayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
  householdId: string;
  data: UpdateHouseholdDto;
}

class HouseholdsUpdateMealTypesPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
  householdId: string;
  data: UpdateHouseholdMealTypesDto;
}

class HouseholdsUpdateMealTimesPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
  householdId: string;
  data: UpdateHouseholdMealTimesDto;
}

class HouseholdsListMembersPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
  householdId: string;
}

class HouseholdsUpdateMemberRolePayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
  householdId: string;
  memberUserId: string;
  data: UpdateMemberRoleDto;
}

class HouseholdsRemoveMemberPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
  householdId: string;
  memberUserId: string;
}

class HouseholdsLeavePayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
  householdId: string;
}

@WebSocketGateway(WS_GATEWAY_OPTIONS)
export class HouseholdsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  private server: Server;

  constructor(
    private readonly householdsService: HouseholdsService,
    private readonly wsTelemetry: WsTelemetryService,
    private readonly notificationsService: NotificationsService,
  ) {}

  /**
   * Rozgłasza zmianę składu gospodarstwa RAZEM z nową listą domowników.
   *
   * Sam sygnał „coś się zmieniło" nie wystarczał: klient musiał po niego
   * wrócić osobnym `households:listMembers`, a gdy ten round-trip nie
   * przechodził (a nie przechodził, bo szedł świeżo otwieranym socketem),
   * zaproszona osoba nie pojawiała się na liście i nikt się o tym nie
   * dowiadywał. Ładunek z listą kopiuje wzorzec `households:mealTypesChanged`,
   * który tak robi od początku. Pola zostają dotychczasowe, więc starszy
   * klient nic nie traci — po prostu ignoruje `members`.
   */
  private async emitMembersChanged(input: {
    householdId: string;
    action: string;
    changedByUserId: string;
    changedByDisplayName?: string | null;
  }): Promise<void> {
    let members: unknown[] | undefined;
    try {
      members = await this.householdsService.listMembers(
        input.changedByUserId,
        input.householdId,
      );
    } catch {
      // Autor zmiany bywa już poza gospodarstwem (`households:leave`), więc
      // odczyt listy potrafi odbić się o kontrolę członkostwa. Zdarzenie i tak
      // musi wyjść — bez `members` klient zrobi to, co robił dotąd, czyli
      // dociągnie listę sam.
      members = undefined;
    }

    broadcastToHousehold(
      this.server,
      input.householdId,
      'households:membersChanged',
      {
        householdId: input.householdId,
        action: input.action,
        changedByUserId: input.changedByUserId,
        changedByDisplayName: input.changedByDisplayName ?? null,
        ...(members ? { members } : {}),
      },
    );
  }

  /**
   * Zmiana składu domu zmienia też plan: posiłki solo odchodzącego znikają,
   * auto-porcje „Wspólnych" liczą się od nowa, a za nimi lista zakupów
   * (`plan-roster.util.ts`). Klient iOS na `households:membersChanged`
   * odświeża wyłącznie listę domowników, więc każdy dotknięty tydzień dostaje
   * zwykłe `weeklyPlans:weekChanged` + `shoppingListChanged` — oba gatewaye
   * dzielą jeden serwer Socket.IO (te same `WS_GATEWAY_OPTIONS`, bez
   * namespace'u). Akcja `MEMBERSHIP_CHANGED` jest klientowi nieznana, a
   * `singleChangeText` oddaje dla niej `nil`: telefon przeładowuje tydzień
   * bez fałszywego bannera „X zmienił plan".
   */
  private emitPlanTouched(input: {
    weeks: Array<{ householdId: string; weekStart: string }>;
    changedByUserId: string;
    changedByDisplayName?: string | null;
  }): void {
    for (const { householdId, weekStart } of input.weeks) {
      const changeVersion = Date.now();
      broadcastToHousehold(
        this.server,
        householdId,
        'weeklyPlans:weekChanged',
        {
          householdId,
          weekStart,
          action: 'MEMBERSHIP_CHANGED',
          changedByUserId: input.changedByUserId,
          changedByDisplayName: input.changedByDisplayName ?? null,
          changeVersion,
        },
      );
      broadcastToHousehold(
        this.server,
        householdId,
        'weeklyPlans:shoppingListChanged',
        {
          householdId,
          weekStart,
          action: 'MEMBERSHIP_CHANGED',
          changedByUserId: input.changedByUserId,
          changedByDisplayName: input.changedByDisplayName ?? null,
          productKey: null,
          isChecked: null,
          changeVersion,
        },
      );
    }
  }

  handleConnection(_client: Socket) {
    this.wsTelemetry.onConnect(HouseholdsGateway.name);
  }

  handleDisconnect(_client: Socket) {
    this.wsTelemetry.onDisconnect(HouseholdsGateway.name);
  }

  @SubscribeMessage('households:findAll')
  findAll(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: HouseholdsUserPayload,
  ) {
    return wsRespond(() =>
      this.householdsService.findAll(actorId(client, payload)),
    );
  }

  @SubscribeMessage('households:findById')
  findById(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: HouseholdsFindByIdPayload,
  ) {
    return wsRespond(() =>
      this.householdsService.findById(actorId(client, payload), payload.id),
    );
  }

  @SubscribeMessage('households:create')
  create(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: HouseholdsCreatePayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      const changedByDisplayName =
        await this.householdsService.getUserDisplayName(userId);
      const result = await this.householdsService.create(userId, payload.data);
      // Założyciel wchodzi do pokoju domu PRZED rozgłoszeniem — inaczej jego
      // własne sockety (a iOS trzyma ich kilka) nie dostałyby `membersChanged`.
      joinHousehold(this.server, userId, result.id);
      await this.emitMembersChanged({
        householdId: result.id,
        action: 'CREATE_HOUSEHOLD',
        changedByUserId: userId,
        changedByDisplayName,
      });
      return result;
    });
  }

  @SubscribeMessage('households:createInvitation')
  createInvitation(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: HouseholdsCreateInvitationPayload,
  ) {
    return wsRespond(() =>
      this.householdsService.createInvitation(
        actorId(client, payload),
        payload.householdId,
        payload.data,
      ),
    );
  }

  @SubscribeMessage('households:acceptInvitation')
  acceptInvitation(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: HouseholdsAcceptInvitationPayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      const changedByDisplayName =
        await this.householdsService.getUserDisplayName(userId);
      const result = await this.householdsService.acceptInvitation(
        userId,
        payload.data,
      );
      // JOIN przed emitem: nowy domownik ma dostać `membersChanged` nowego
      // domu na wszystkich swoich socketach.
      joinHousehold(this.server, userId, result.householdId);
      await this.emitMembersChanged({
        householdId: result.householdId,
        action: 'ACCEPT_INVITATION',
        changedByUserId: userId,
        changedByDisplayName,
      });
      this.emitPlanTouched({
        weeks: result.touchedWeeks,
        changedByUserId: userId,
        changedByDisplayName,
      });

      // Domy, z których ta osoba właśnie wyszła, też muszą się dowiedzieć —
      // ich domownikom zmieniła się liczba porcji i zawartość listy zakupów.
      // Dom, który przy okazji zniknął (bo został pusty), nie ma już komu
      // niczego rozgłosić; `emitMembersChanged` przechodzi wtedy bez listy.
      for (const leftHouseholdId of result.leftHouseholdIds) {
        await this.emitMembersChanged({
          householdId: leftHouseholdId,
          action: 'LEAVE',
          changedByUserId: userId,
          changedByDisplayName,
        });
        void this.notificationsService
          .notifyHouseholdMembershipChanged({
            householdId: leftHouseholdId,
            actorUserId: userId,
            actorDisplayName: changedByDisplayName,
            action: 'LEFT',
          })
          .catch(() => undefined);
      }

      // LEAVE dopiero po emitach: iOS rozpoznaje „wyszedłem" po braku
      // własnego id w `members` z `membersChanged`, więc musi je jeszcze dostać.
      for (const leftHouseholdId of result.leftHouseholdIds) {
        leaveHousehold(this.server, userId, leftHouseholdId);
      }

      // Push do pozostałych domowników. Dotąd nie było go w ogóle: właściciel
      // gospodarstwa wysyłał zaproszenie i nie dowiadywał się, że ktoś je
      // przyjął — ani powiadomieniem, ani odświeżoną listą. To jedno z
      // niewielu zdarzeń, na które ktoś realnie czeka, więc idzie od razu,
      // z dźwiękiem, z pominięciem bufora i ciszy nocnej.
      //
      // Bez `await` na całości: nazwa gospodarstwa jest tylko ozdobą treści,
      // a odpowiedź na `households:acceptInvitation` nie ma na nią czekać.
      void this.householdsService
        .findById(userId, result.householdId)
        .then((household) => household?.name ?? null)
        .catch(() => null)
        .then((householdName) =>
          this.notificationsService.notifyHouseholdMembershipChanged({
            householdId: result.householdId,
            actorUserId: userId,
            actorDisplayName: changedByDisplayName,
            householdName,
            action: 'JOINED',
          }),
        )
        .catch(() => undefined);

      return result;
    });
  }

  @SubscribeMessage('households:previewInvitation')
  previewInvitation(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: HouseholdsPreviewInvitationPayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      const preview = await this.householdsService.previewInvitation(
        userId,
        payload.data,
      );

      // Powiadomienie leci raz — dokładnie wtedy, gdy zaproszenie trafiło do
      // skrzynki tego użytkownika. Kolejne otwarcia tego samego linku nie mają
      // już czego zgłaszać, więc nie robią hałasu.
      if (preview.addedToInbox && preview.household) {
        void this.notificationsService
          .notifyHouseholdInvitation({
            invitedUserId: userId,
            householdId: preview.household.id,
            householdName: preview.household.name,
            invitedByDisplayName: preview.invitedByDisplayName,
          })
          .catch(() => undefined);
      }

      return preview;
    });
  }

  /**
   * Zaproszenia czekające na zalogowanego użytkownika. Zasila kartę
   * „Zaproszenia" w Ustawieniach → Gospodarstwo.
   */
  @SubscribeMessage('households:listPendingInvitations')
  listPendingInvitations(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: HouseholdsUserPayload,
  ) {
    return wsRespond(() =>
      this.householdsService.listPendingInvitations(actorId(client, payload)),
    );
  }

  @SubscribeMessage('households:declineInvitation')
  declineInvitation(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: HouseholdsDeclineInvitationPayload,
  ) {
    return wsRespond(() =>
      this.householdsService.declineInvitation(
        actorId(client, payload),
        payload.data,
      ),
    );
  }

  @SubscribeMessage('households:updateName')
  updateName(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: HouseholdsUpdateNamePayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      const changedByDisplayName =
        await this.householdsService.getUserDisplayName(userId);
      const result = await this.householdsService.updateName(
        userId,
        payload.householdId,
        payload.data,
      );
      await this.emitMembersChanged({
        householdId: payload.householdId,
        action: 'UPDATE_NAME',
        changedByUserId: userId,
        changedByDisplayName,
      });
      return result;
    });
  }

  /**
   * Zmiana zestawu posiłków planowanych przez gospodarstwo.
   *
   * Rozgłaszane osobnym zdarzeniem (`households:mealTypesChanged`), a nie
   * przez `membersChanged`: tamto klient traktuje jak „odśwież listę
   * domowników", a tu chodzi o przebudowę planu tygodnia u wszystkich naraz.
   * W ładunku jedzie już nowa lista, więc odbiorcy nie muszą po nią wracać.
   */
  @SubscribeMessage('households:updateMealTypes')
  updateMealTypes(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: HouseholdsUpdateMealTypesPayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      const changedByDisplayName =
        await this.householdsService.getUserDisplayName(userId);
      const result = await this.householdsService.updateMealTypes(
        userId,
        payload.householdId,
        payload.data,
      );
      broadcastToHousehold(
        this.server,
        payload.householdId,
        'households:mealTypesChanged',
        {
          householdId: payload.householdId,
          mealTypes: result.enabledMealTypes,
          changedByUserId: userId,
          changedByDisplayName,
        },
      );
      return result;
    });
  }

  @SubscribeMessage('households:updateMealTimes')
  updateMealTimes(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: HouseholdsUpdateMealTimesPayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      const changedByDisplayName =
        await this.householdsService.getUserDisplayName(userId);
      const result = await this.householdsService.updateMealTimes(
        userId,
        payload.householdId,
        payload.data,
      );
      broadcastToHousehold(
        this.server,
        payload.householdId,
        'households:mealTimesChanged',
        {
          householdId: payload.householdId,
          mealSlotTimes: result.mealSlotTimes,
          changedByUserId: userId,
          changedByDisplayName,
        },
      );
      return result;
    });
  }

  @SubscribeMessage('households:listMembers')
  listMembers(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: HouseholdsListMembersPayload,
  ) {
    return wsRespond(() =>
      this.householdsService.listMembers(
        actorId(client, payload),
        payload.householdId,
      ),
    );
  }

  @SubscribeMessage('households:updateMemberRole')
  updateMemberRole(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: HouseholdsUpdateMemberRolePayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      const changedByDisplayName =
        await this.householdsService.getUserDisplayName(userId);
      const result = await this.householdsService.updateMemberRole(
        userId,
        payload.householdId,
        payload.memberUserId,
        payload.data,
      );
      await this.emitMembersChanged({
        householdId: payload.householdId,
        action: 'UPDATE_MEMBER_ROLE',
        changedByUserId: userId,
        changedByDisplayName,
      });
      return result;
    });
  }

  @SubscribeMessage('households:removeMember')
  removeMember(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: HouseholdsRemoveMemberPayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      const changedByDisplayName =
        await this.householdsService.getUserDisplayName(userId);
      const result = await this.householdsService.removeMember(
        userId,
        payload.householdId,
        payload.memberUserId,
      );
      await this.emitMembersChanged({
        householdId: payload.householdId,
        action: 'REMOVE_MEMBER',
        changedByUserId: userId,
        changedByDisplayName,
      });
      this.emitPlanTouched({
        weeks: result.touchedWeekStarts.map((weekStart) => ({
          householdId: payload.householdId,
          weekStart,
        })),
        changedByUserId: userId,
        changedByDisplayName,
      });
      // Usuwany wychodzi z pokoju dopiero PO emitach — z `membersChanged` bez
      // swojego id iOS wnioskuje „usunięto mnie".
      leaveHousehold(this.server, payload.memberUserId, payload.householdId);
      return result;
    });
  }

  @SubscribeMessage('households:leave')
  leave(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: HouseholdsLeavePayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      const changedByDisplayName =
        await this.householdsService.getUserDisplayName(userId);
      const result = await this.householdsService.leave(
        userId,
        payload.householdId,
      );
      await this.emitMembersChanged({
        householdId: payload.householdId,
        action: 'LEAVE',
        changedByUserId: userId,
        changedByDisplayName,
      });
      this.emitPlanTouched({
        weeks: result.touchedWeekStarts.map((weekStart) => ({
          householdId: payload.householdId,
          weekStart,
        })),
        changedByUserId: userId,
        changedByDisplayName,
      });
      // Odchodzący opuszcza pokój PO emitach (patrz `ws-rooms.ts`).
      leaveHousehold(this.server, userId, payload.householdId);

      // Odejście domownika zmienia liczbę porcji, listę zakupów i to, kto ma
      // dostęp do planu — reszta domu powinna o tym wiedzieć od razu, a nie
      // zorientować się po zmienionych gramaturach.
      void this.notificationsService
        .notifyHouseholdMembershipChanged({
          householdId: payload.householdId,
          actorUserId: userId,
          actorDisplayName: changedByDisplayName,
          action: 'LEFT',
        })
        .catch(() => undefined);

      return result;
    });
  }
}
