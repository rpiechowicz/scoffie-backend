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
  userId: string;
}

class HouseholdsFindByIdPayload {
  userId: string;
  id: string;
}

class HouseholdsCreatePayload {
  userId: string;
  data: CreateHouseholdDto;
}

class HouseholdsCreateInvitationPayload {
  userId: string;
  householdId: string;
  data: CreateInvitationDto;
}

class HouseholdsAcceptInvitationPayload {
  userId: string;
  data: AcceptInvitationDto;
}

class HouseholdsPreviewInvitationPayload {
  userId: string;
  data: AcceptInvitationDto;
}

class HouseholdsDeclineInvitationPayload {
  userId: string;
  data: AcceptInvitationDto;
}

class HouseholdsUpdateNamePayload {
  userId: string;
  householdId: string;
  data: UpdateHouseholdDto;
}

class HouseholdsUpdateMealTypesPayload {
  userId: string;
  householdId: string;
  data: UpdateHouseholdMealTypesDto;
}

class HouseholdsUpdateMealTimesPayload {
  userId: string;
  householdId: string;
  data: UpdateHouseholdMealTimesDto;
}

class HouseholdsListMembersPayload {
  userId: string;
  householdId: string;
}

class HouseholdsUpdateMemberRolePayload {
  userId: string;
  householdId: string;
  memberUserId: string;
  data: UpdateMemberRoleDto;
}

class HouseholdsRemoveMemberPayload {
  userId: string;
  householdId: string;
  memberUserId: string;
}

class HouseholdsLeavePayload {
  userId: string;
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

    this.server.emit('households:membersChanged', {
      householdId: input.householdId,
      action: input.action,
      changedByUserId: input.changedByUserId,
      changedByDisplayName: input.changedByDisplayName ?? null,
      ...(members ? { members } : {}),
    });
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
      this.server.emit('weeklyPlans:weekChanged', {
        householdId,
        weekStart,
        action: 'MEMBERSHIP_CHANGED',
        changedByUserId: input.changedByUserId,
        changedByDisplayName: input.changedByDisplayName ?? null,
        changeVersion,
      });
      this.server.emit('weeklyPlans:shoppingListChanged', {
        householdId,
        weekStart,
        action: 'MEMBERSHIP_CHANGED',
        changedByUserId: input.changedByUserId,
        changedByDisplayName: input.changedByDisplayName ?? null,
        productKey: null,
        isChecked: null,
        changeVersion,
      });
    }
  }

  handleConnection(_client: Socket) {
    this.wsTelemetry.onConnect(HouseholdsGateway.name);
  }

  handleDisconnect(_client: Socket) {
    this.wsTelemetry.onDisconnect(HouseholdsGateway.name);
  }

  @SubscribeMessage('households:findAll')
  findAll(@MessageBody() payload: HouseholdsUserPayload) {
    return wsRespond(() => this.householdsService.findAll(payload.userId));
  }

  @SubscribeMessage('households:findById')
  findById(@MessageBody() payload: HouseholdsFindByIdPayload) {
    return wsRespond(() =>
      this.householdsService.findById(payload.userId, payload.id),
    );
  }

  @SubscribeMessage('households:create')
  create(@MessageBody() payload: HouseholdsCreatePayload) {
    return wsRespond(async () => {
      const changedByDisplayName =
        await this.householdsService.getUserDisplayName(payload.userId);
      const result = await this.householdsService.create(
        payload.userId,
        payload.data,
      );
      await this.emitMembersChanged({
        householdId: result.id,
        action: 'CREATE_HOUSEHOLD',
        changedByUserId: payload.userId,
        changedByDisplayName,
      });
      return result;
    });
  }

  @SubscribeMessage('households:createInvitation')
  createInvitation(@MessageBody() payload: HouseholdsCreateInvitationPayload) {
    return wsRespond(() =>
      this.householdsService.createInvitation(
        payload.userId,
        payload.householdId,
        payload.data,
      ),
    );
  }

  @SubscribeMessage('households:acceptInvitation')
  acceptInvitation(@MessageBody() payload: HouseholdsAcceptInvitationPayload) {
    return wsRespond(async () => {
      const changedByDisplayName =
        await this.householdsService.getUserDisplayName(payload.userId);
      const result = await this.householdsService.acceptInvitation(
        payload.userId,
        payload.data,
      );
      await this.emitMembersChanged({
        householdId: result.householdId,
        action: 'ACCEPT_INVITATION',
        changedByUserId: payload.userId,
        changedByDisplayName,
      });
      this.emitPlanTouched({
        weeks: result.touchedWeeks,
        changedByUserId: payload.userId,
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
          changedByUserId: payload.userId,
          changedByDisplayName,
        });
        void this.notificationsService
          .notifyHouseholdMembershipChanged({
            householdId: leftHouseholdId,
            actorUserId: payload.userId,
            actorDisplayName: changedByDisplayName,
            action: 'LEFT',
          })
          .catch(() => undefined);
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
        .findById(payload.userId, result.householdId)
        .then((household) => household?.name ?? null)
        .catch(() => null)
        .then((householdName) =>
          this.notificationsService.notifyHouseholdMembershipChanged({
            householdId: result.householdId,
            actorUserId: payload.userId,
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
    @MessageBody() payload: HouseholdsPreviewInvitationPayload,
  ) {
    return wsRespond(async () => {
      const preview = await this.householdsService.previewInvitation(
        payload.userId,
        payload.data,
      );

      // Powiadomienie leci raz — dokładnie wtedy, gdy zaproszenie trafiło do
      // skrzynki tego użytkownika. Kolejne otwarcia tego samego linku nie mają
      // już czego zgłaszać, więc nie robią hałasu.
      if (preview.addedToInbox && preview.household) {
        void this.notificationsService
          .notifyHouseholdInvitation({
            invitedUserId: payload.userId,
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
  listPendingInvitations(@MessageBody() payload: HouseholdsUserPayload) {
    return wsRespond(() =>
      this.householdsService.listPendingInvitations(payload.userId),
    );
  }

  @SubscribeMessage('households:declineInvitation')
  declineInvitation(
    @MessageBody() payload: HouseholdsDeclineInvitationPayload,
  ) {
    return wsRespond(() =>
      this.householdsService.declineInvitation(payload.userId, payload.data),
    );
  }

  @SubscribeMessage('households:updateName')
  updateName(@MessageBody() payload: HouseholdsUpdateNamePayload) {
    return wsRespond(async () => {
      const changedByDisplayName =
        await this.householdsService.getUserDisplayName(payload.userId);
      const result = await this.householdsService.updateName(
        payload.userId,
        payload.householdId,
        payload.data,
      );
      await this.emitMembersChanged({
        householdId: payload.householdId,
        action: 'UPDATE_NAME',
        changedByUserId: payload.userId,
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
  updateMealTypes(@MessageBody() payload: HouseholdsUpdateMealTypesPayload) {
    return wsRespond(async () => {
      const changedByDisplayName =
        await this.householdsService.getUserDisplayName(payload.userId);
      const result = await this.householdsService.updateMealTypes(
        payload.userId,
        payload.householdId,
        payload.data,
      );
      this.server.emit('households:mealTypesChanged', {
        householdId: payload.householdId,
        mealTypes: result.enabledMealTypes,
        changedByUserId: payload.userId,
        changedByDisplayName,
      });
      return result;
    });
  }

  @SubscribeMessage('households:updateMealTimes')
  updateMealTimes(@MessageBody() payload: HouseholdsUpdateMealTimesPayload) {
    return wsRespond(async () => {
      const changedByDisplayName =
        await this.householdsService.getUserDisplayName(payload.userId);
      const result = await this.householdsService.updateMealTimes(
        payload.userId,
        payload.householdId,
        payload.data,
      );
      this.server.emit('households:mealTimesChanged', {
        householdId: payload.householdId,
        mealSlotTimes: result.mealSlotTimes,
        changedByUserId: payload.userId,
        changedByDisplayName,
      });
      return result;
    });
  }

  @SubscribeMessage('households:listMembers')
  listMembers(@MessageBody() payload: HouseholdsListMembersPayload) {
    return wsRespond(() =>
      this.householdsService.listMembers(payload.userId, payload.householdId),
    );
  }

  @SubscribeMessage('households:updateMemberRole')
  updateMemberRole(@MessageBody() payload: HouseholdsUpdateMemberRolePayload) {
    return wsRespond(async () => {
      const changedByDisplayName =
        await this.householdsService.getUserDisplayName(payload.userId);
      const result = await this.householdsService.updateMemberRole(
        payload.userId,
        payload.householdId,
        payload.memberUserId,
        payload.data,
      );
      await this.emitMembersChanged({
        householdId: payload.householdId,
        action: 'UPDATE_MEMBER_ROLE',
        changedByUserId: payload.userId,
        changedByDisplayName,
      });
      return result;
    });
  }

  @SubscribeMessage('households:removeMember')
  removeMember(@MessageBody() payload: HouseholdsRemoveMemberPayload) {
    return wsRespond(async () => {
      const changedByDisplayName =
        await this.householdsService.getUserDisplayName(payload.userId);
      const result = await this.householdsService.removeMember(
        payload.userId,
        payload.householdId,
        payload.memberUserId,
      );
      await this.emitMembersChanged({
        householdId: payload.householdId,
        action: 'REMOVE_MEMBER',
        changedByUserId: payload.userId,
        changedByDisplayName,
      });
      this.emitPlanTouched({
        weeks: result.touchedWeekStarts.map((weekStart) => ({
          householdId: payload.householdId,
          weekStart,
        })),
        changedByUserId: payload.userId,
        changedByDisplayName,
      });
      return result;
    });
  }

  @SubscribeMessage('households:leave')
  leave(@MessageBody() payload: HouseholdsLeavePayload) {
    return wsRespond(async () => {
      const changedByDisplayName =
        await this.householdsService.getUserDisplayName(payload.userId);
      const result = await this.householdsService.leave(
        payload.userId,
        payload.householdId,
      );
      await this.emitMembersChanged({
        householdId: payload.householdId,
        action: 'LEAVE',
        changedByUserId: payload.userId,
        changedByDisplayName,
      });
      this.emitPlanTouched({
        weeks: result.touchedWeekStarts.map((weekStart) => ({
          householdId: payload.householdId,
          weekStart,
        })),
        changedByUserId: payload.userId,
        changedByDisplayName,
      });

      // Odejście domownika zmienia liczbę porcji, listę zakupów i to, kto ma
      // dostęp do planu — reszta domu powinna o tym wiedzieć od razu, a nie
      // zorientować się po zmienionych gramaturach.
      void this.notificationsService
        .notifyHouseholdMembershipChanged({
          householdId: payload.householdId,
          actorUserId: payload.userId,
          actorDisplayName: changedByDisplayName,
          action: 'LEFT',
        })
        .catch(() => undefined);

      return result;
    });
  }
}
