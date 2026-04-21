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
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { Server, Socket } from 'socket.io';
import { WsTelemetryService } from '../common/ws-telemetry.service';

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

class HouseholdsUpdateNamePayload {
  userId: string;
  householdId: string;
  data: UpdateHouseholdDto;
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
  ) {}

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
      this.server.emit('households:membersChanged', {
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
      this.server.emit('households:membersChanged', {
        householdId: result.householdId,
        action: 'ACCEPT_INVITATION',
        changedByUserId: payload.userId,
        changedByDisplayName,
      });
      return result;
    });
  }

  @SubscribeMessage('households:previewInvitation')
  previewInvitation(
    @MessageBody() payload: HouseholdsPreviewInvitationPayload,
  ) {
    return wsRespond(() =>
      this.householdsService.previewInvitation(payload.userId, payload.data),
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
      this.server.emit('households:membersChanged', {
        householdId: payload.householdId,
        action: 'UPDATE_NAME',
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
      this.server.emit('households:membersChanged', {
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
      this.server.emit('households:membersChanged', {
        householdId: payload.householdId,
        action: 'REMOVE_MEMBER',
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
      this.server.emit('households:membersChanged', {
        householdId: payload.householdId,
        action: 'LEAVE',
        changedByUserId: payload.userId,
        changedByDisplayName,
      });
      return result;
    });
  }
}
