import {
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { WS_GATEWAY_OPTIONS } from '../common/ws-gateway-options';
import { wsRespond } from '../common/ws-response';
import { UsersService } from './users.service';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { Socket } from 'socket.io';
import { WsTelemetryService } from '../common/ws-telemetry.service';

class UsersMePayload {
  userId: string;
}

class UsersPreferencesGetPayload {
  userId: string;
}

class UsersPreferencesUpdatePayload {
  userId: string;
  data: UpdatePreferencesDto;
}

class UsersProfileUpdatePayload {
  userId: string;
  data: UpdateProfileDto;
}

class UsersOnboardingCompletePayload {
  userId: string;
}

class UsersDeletePayload {
  userId: string;
}

@WebSocketGateway(WS_GATEWAY_OPTIONS)
export class UsersGateway implements OnGatewayConnection, OnGatewayDisconnect {
  constructor(
    private readonly usersService: UsersService,
    private readonly wsTelemetry: WsTelemetryService,
  ) {}

  handleConnection(_client: Socket) {
    this.wsTelemetry.onConnect(UsersGateway.name);
  }

  handleDisconnect(_client: Socket) {
    this.wsTelemetry.onDisconnect(UsersGateway.name);
  }

  @SubscribeMessage('users:me')
  me(@MessageBody() payload: UsersMePayload) {
    return wsRespond(() => this.usersService.getMe(payload.userId));
  }

  @SubscribeMessage('users:preferences:get')
  getPreferences(@MessageBody() payload: UsersPreferencesGetPayload) {
    return wsRespond(() => this.usersService.getPreferences(payload.userId));
  }

  @SubscribeMessage('users:preferences:update')
  updatePreferences(@MessageBody() payload: UsersPreferencesUpdatePayload) {
    return wsRespond(() =>
      this.usersService.updatePreferences(payload.userId, payload.data),
    );
  }

  @SubscribeMessage('users:profile:update')
  updateProfile(@MessageBody() payload: UsersProfileUpdatePayload) {
    return wsRespond(() =>
      this.usersService.updateProfile(payload.userId, payload.data),
    );
  }

  @SubscribeMessage('users:delete')
  deleteAccount(@MessageBody() payload: UsersDeletePayload) {
    return wsRespond(() => this.usersService.deleteAccount(payload.userId));
  }

  @SubscribeMessage('users:onboarding:complete')
  completeOnboarding(@MessageBody() payload: UsersOnboardingCompletePayload) {
    return wsRespond(() =>
      this.usersService.completeOnboarding(payload.userId),
    );
  }
}
