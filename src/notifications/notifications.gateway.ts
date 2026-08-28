import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { PushPlatform } from '@prisma/client';
import { parseApnsEnvironment } from './apns.service';
import { WS_GATEWAY_OPTIONS } from '../common/ws-gateway-options';
import { wsRespond } from '../common/ws-response';
import { actorId } from '../common/ws-socket';
import type { AppSocket } from '../common/ws-socket';
import { NotificationsService } from './notifications.service';
import { Socket } from 'socket.io';
import { WsTelemetryService } from '../common/ws-telemetry.service';

class NotificationsRegisterDevicePayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
  data: {
    deviceToken: string;
    platform?: PushPlatform;
    appBundleId?: string;
    /** `SANDBOX` (build z Xcode) albo `PRODUCTION` (TestFlight/App Store). */
    apnsEnvironment?: string;
  };
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
    return wsRespond(() =>
      this.notificationsService.registerDevice({
        userId: actorId(client, payload),
        deviceToken: payload.data?.deviceToken ?? '',
        platform: payload.data?.platform,
        appBundleId: payload.data?.appBundleId,
        apnsEnvironment: parseApnsEnvironment(payload.data?.apnsEnvironment),
      }),
    );
  }
}
