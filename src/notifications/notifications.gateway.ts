import { MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { PushPlatform } from '@prisma/client';
import { WS_GATEWAY_OPTIONS } from '../common/ws-gateway-options';
import { wsRespond } from '../common/ws-response';
import { NotificationsService } from './notifications.service';

class NotificationsRegisterDevicePayload {
  userId: string;
  data: {
    deviceToken: string;
    platform?: PushPlatform;
    appBundleId?: string;
  };
}

@WebSocketGateway(WS_GATEWAY_OPTIONS)
export class NotificationsGateway {
  constructor(private readonly notificationsService: NotificationsService) {}

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

