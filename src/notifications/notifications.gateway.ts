import {
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { PushPlatform } from '@prisma/client';
import { WS_GATEWAY_OPTIONS } from '../common/ws-gateway-options';
import { wsRespond } from '../common/ws-response';
import { NotificationsService } from './notifications.service';
import { Socket } from 'socket.io';
import { WsTelemetryService } from '../common/ws-telemetry.service';

class NotificationsRegisterDevicePayload {
  userId: string;
  data: {
    deviceToken: string;
    platform?: PushPlatform;
    appBundleId?: string;
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
  registerDevice(@MessageBody() payload: NotificationsRegisterDevicePayload) {
    return wsRespond(() =>
      this.notificationsService.registerDevice({
        userId: payload.userId,
        deviceToken: payload.data?.deviceToken ?? '',
        platform: payload.data?.platform,
        appBundleId: payload.data?.appBundleId,
      }),
    );
  }
}
