import { MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { WS_GATEWAY_OPTIONS } from '../common/ws-gateway-options';
import { wsRespond } from '../common/ws-response';
import { HouseholdsService } from './households.service';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { CreateHouseholdDto } from './dto/create-household.dto';
import { CreateInvitationDto } from './dto/create-invitation.dto';

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

@WebSocketGateway(WS_GATEWAY_OPTIONS)
export class HouseholdsGateway {
  constructor(private readonly householdsService: HouseholdsService) {}

  @SubscribeMessage('households:findAll')
  findAll(@MessageBody() payload: HouseholdsUserPayload) {
    return wsRespond(() => this.householdsService.findAll(payload.userId));
  }

  @SubscribeMessage('households:findById')
  findById(@MessageBody() payload: HouseholdsFindByIdPayload) {
    return wsRespond(() => this.householdsService.findById(payload.userId, payload.id));
  }

  @SubscribeMessage('households:create')
  create(@MessageBody() payload: HouseholdsCreatePayload) {
    return wsRespond(() => this.householdsService.create(payload.userId, payload.data));
  }

  @SubscribeMessage('households:createInvitation')
  createInvitation(@MessageBody() payload: HouseholdsCreateInvitationPayload) {
    return wsRespond(() =>
      this.householdsService.createInvitation(payload.userId, payload.householdId, payload.data),
    );
  }

  @SubscribeMessage('households:acceptInvitation')
  acceptInvitation(@MessageBody() payload: HouseholdsAcceptInvitationPayload) {
    return wsRespond(() => this.householdsService.acceptInvitation(payload.userId, payload.data));
  }
}
