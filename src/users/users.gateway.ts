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
import { CreateUserDto } from './dto/create-user.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { Socket } from 'socket.io';
import { WsTelemetryService } from '../common/ws-telemetry.service';

class UsersMePayload {
  userId: string;
}

class UsersFindByIdPayload {
  id: string;
}

class UsersPreferencesGetPayload {
  userId: string;
}

class UsersPreferencesUpdatePayload {
  userId: string;
  data: UpdatePreferencesDto;
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

  @SubscribeMessage('users:findAll')
  findAll() {
    return wsRespond(() => this.usersService.findAll());
  }

  @SubscribeMessage('users:findById')
  findById(@MessageBody() payload: UsersFindByIdPayload) {
    return wsRespond(() => this.usersService.findById(payload.id));
  }

  @SubscribeMessage('users:create')
  create(@MessageBody() payload: CreateUserDto) {
    return wsRespond(() => this.usersService.create(payload));
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
}
