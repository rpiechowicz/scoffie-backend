import { Optional } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { validateWsPayload } from '../common/validate-dto';
import { WS_GATEWAY_OPTIONS } from '../common/ws-gateway-options';
import { wsRespond } from '../common/ws-response';
import type { AppSocket } from '../common/ws-socket';
import { actorId } from '../common/ws-socket';
import { disconnectUser } from '../common/ws-rooms';
import { UsersService } from './users.service';
import { AppleRevocationService } from './apple-revocation.service';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { Server, Socket } from 'socket.io';
import { WsTelemetryService } from '../common/ws-telemetry.service';

/**
 * Koperta zdarzeń bez wejścia (`users:me`, `users:preferences:get`,
 * `users:delete`, `users:onboarding:complete`): jedyne pole to legacy
 * `userId`, więc nie ma czego walidować — handler bierze tożsamość z
 * `actorId`, który znosi także `payload === undefined`.
 */
class UsersActorPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  @IsOptional()
  @IsString()
  userId?: string;
}

/**
 * Koperty z `data`: `validateWsPayload` sprawdza tylko, że `data` jest
 * obiektem (brak `data` = VALIDATION_ERROR zamiast `TypeError` → 500).
 * Zawartość waliduje serwis przez `validateDto(UpdatePreferencesDto/…)` —
 * każde pole dokładnie raz, dlatego bez `@ValidateNested` tutaj.
 */
/**
 * Kasowanie konta: opcjonalny świeży kod autoryzacji Sign in with Apple.
 * Telefon zdobywa go ponownym `ASAuthorizationAppleIDRequest` tuż przed
 * kasowaniem; serwer unieważnia nim tokeny u Apple (wytyczne 5.1.1(v)).
 * Brak kodu (konto Google/dev, stary build) = kasowanie jak dotąd.
 */
class UsersDeletePayload extends UsersActorPayload {
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  appleAuthorizationCode?: string;
}

class UsersPreferencesUpdatePayload extends UsersActorPayload {
  @IsObject()
  data: UpdatePreferencesDto;
}

class UsersProfileUpdatePayload extends UsersActorPayload {
  @IsObject()
  data: UpdateProfileDto;
}

@WebSocketGateway(WS_GATEWAY_OPTIONS)
export class UsersGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly usersService: UsersService,
    private readonly wsTelemetry: WsTelemetryService,
    // Opcjonalnie: testy jednostkowe bramki nie stawiają tego serwisu.
    @Optional() private readonly appleRevocation?: AppleRevocationService,
  ) {}

  handleConnection(_client: Socket) {
    this.wsTelemetry.onConnect(UsersGateway.name);
  }

  handleDisconnect(_client: Socket) {
    this.wsTelemetry.onDisconnect(UsersGateway.name);
  }

  @SubscribeMessage('users:me')
  me(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: UsersActorPayload,
  ) {
    return wsRespond(() => this.usersService.getMe(actorId(client, payload)));
  }

  @SubscribeMessage('users:preferences:get')
  getPreferences(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: UsersActorPayload,
  ) {
    return wsRespond(() =>
      this.usersService.getPreferences(actorId(client, payload)),
    );
  }

  @SubscribeMessage('users:preferences:update')
  updatePreferences(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: UsersPreferencesUpdatePayload,
  ) {
    return wsRespond(async () => {
      // Najpierw tożsamość, potem koperta: anonimowy socket ma dostać
      // UNAUTHORIZED, nie VALIDATION_ERROR (pilnuje tego ws-handlers-auth.spec).
      const userId = actorId(client, payload);
      await validateWsPayload(UsersPreferencesUpdatePayload, payload);
      return this.usersService.updatePreferences(userId, payload.data);
    });
  }

  @SubscribeMessage('users:profile:update')
  updateProfile(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: UsersProfileUpdatePayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      await validateWsPayload(UsersProfileUpdatePayload, payload);
      return this.usersService.updateProfile(userId, payload.data);
    });
  }

  /**
   * Po skasowaniu konta rozłączamy wszystkie sockety użytkownika: jego JWT
   * jest jeszcze ważny do `exp`, a nie może dalej pracować na nieistniejącym
   * koncie. Rozłączenie idzie po pokoju `user:<id>`, więc łapie też sockety
   * inne niż ten, z którego przyszło `users:delete`.
   *
   * Rozłączenie jest odroczone (`setImmediate`): Nest pisze ack dopiero po
   * rozwiązaniu promise handlera, a socket.io porzuca pakiety do zamkniętego
   * połączenia — synchroniczne `disconnectSockets(true)` wewnątrz handlera
   * zjadłoby ack i iOS czekałby 3×6 s na odpowiedź, której nie dostanie.
   */
  @SubscribeMessage('users:delete')
  deleteAccount(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: UsersDeletePayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      // Najpierw Apple, potem baza: kod jest jednorazowy i żyje 5 minut,
      // a porażka u Apple nie blokuje kasowania (prawo z art. 17 RODO).
      const code = payload?.appleAuthorizationCode?.trim();
      if (code && this.appleRevocation) {
        await this.appleRevocation.revoke(code);
      }
      const result = await this.usersService.deleteAccount(userId);
      setImmediate(() => disconnectUser(this.server, userId));
      return result;
    });
  }

  @SubscribeMessage('users:onboarding:complete')
  completeOnboarding(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: UsersActorPayload,
  ) {
    return wsRespond(() =>
      this.usersService.completeOnboarding(actorId(client, payload)),
    );
  }
}
