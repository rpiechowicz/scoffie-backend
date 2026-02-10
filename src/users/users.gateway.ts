import { MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { WS_GATEWAY_OPTIONS } from '../common/ws-gateway-options';
import { wsRespond } from '../common/ws-response';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';

class UsersMePayload {
  userId: string;
}

class UsersFindByIdPayload {
  id: string;
}

@WebSocketGateway(WS_GATEWAY_OPTIONS)
export class UsersGateway {
  constructor(private readonly usersService: UsersService) {}

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
}
