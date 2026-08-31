import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { IsObject, IsOptional, IsString } from 'class-validator';
import { validateWsPayload } from '../common/validate-dto';
import { WS_GATEWAY_OPTIONS } from '../common/ws-gateway-options';
import { wsRespond } from '../common/ws-response';
import { actorId } from '../common/ws-socket';
import type { AppSocket } from '../common/ws-socket';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { NotificationsService } from './notifications.service';
import { Socket } from 'socket.io';
import { WsTelemetryService } from '../common/ws-telemetry.service';

/**
 * Koperta zdarzenia. Dekorator na KAŻDYM polu — whitelist wycina pola bez
 * dekoratora. `data` tylko `@IsObject()`: zawartość waliduje serwis
 * (`RegisterDeviceDto`), żeby każde pole sprawdzało się dokładnie raz.
 */
class NotificationsRegisterDevicePayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  @IsOptional()
  @IsString()
  userId?: string;

  @IsObject()
  data: RegisterDeviceDto;
}

@WebSocketGateway(WS_GATEWAY_OPTIONS)
export class NotificationsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly wsTelemetry: WsTelemetryService,
  ) {}

  handleConnection(_client: Socket) {
    this.wsTelemetry.onConnect(NotificationsGateway.name);
  }

  handleDisconnect(_client: Socket) {
    this.wsTelemetry.onDisconnect(NotificationsGateway.name);
  }

  @SubscribeMessage('notifications:registerDevice')
  registerDevice(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: NotificationsRegisterDevicePayload,
  ) {
    // Token urządzenia przypina się do konta z socketu, nie z payloadu — inaczej
    // dowolny klient mógłby podpiąć swój telefon pod cudze powiadomienia.
    // Najpierw tożsamość, potem koperta: anonimowy socket ma dostać
    // UNAUTHORIZED, nie VALIDATION_ERROR.
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      await validateWsPayload(NotificationsRegisterDevicePayload, payload);
      return this.notificationsService.registerDevice(userId, payload.data);
    });
  }
}
