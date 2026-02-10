import { MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { WS_GATEWAY_OPTIONS } from '../common/ws-gateway-options';
import { wsRespond } from '../common/ws-response';
import { WeeklyPlansService } from './weekly-plans.service';
import { CreatePlanItemDto } from './dto/create-plan-item.dto';
import { CreateWeeklyPlanDto } from './dto/create-weekly-plan.dto';

class WeeklyPlansListPayload {
  userId: string;
  householdId: string;
}

class WeeklyPlansGetByWeekPayload {
  userId: string;
  householdId: string;
  weekStart: string;
}

class WeeklyPlansCreatePayload {
  userId: string;
  householdId: string;
  data: CreateWeeklyPlanDto;
}

class WeeklyPlansAddItemPayload {
  userId: string;
  weeklyPlanId: string;
  data: CreatePlanItemDto;
}

class WeeklyPlansRemoveItemPayload {
  userId: string;
  itemId: string;
}

@WebSocketGateway(WS_GATEWAY_OPTIONS)
export class WeeklyPlansGateway {
  constructor(private readonly weeklyPlansService: WeeklyPlansService) {}

  @SubscribeMessage('weeklyPlans:listByHousehold')
  listByHousehold(@MessageBody() payload: WeeklyPlansListPayload) {
    return wsRespond(() => this.weeklyPlansService.listByHousehold(payload.userId, payload.householdId));
  }

  @SubscribeMessage('weeklyPlans:getByWeek')
  getByWeek(@MessageBody() payload: WeeklyPlansGetByWeekPayload) {
    return wsRespond(() =>
      this.weeklyPlansService.getByHouseholdAndWeek(payload.userId, payload.householdId, payload.weekStart),
    );
  }

  @SubscribeMessage('weeklyPlans:create')
  create(@MessageBody() payload: WeeklyPlansCreatePayload) {
    return wsRespond(() => this.weeklyPlansService.create(payload.userId, payload.householdId, payload.data));
  }

  @SubscribeMessage('weeklyPlans:addItem')
  addItem(@MessageBody() payload: WeeklyPlansAddItemPayload) {
    return wsRespond(() => this.weeklyPlansService.addItem(payload.userId, payload.weeklyPlanId, payload.data));
  }

  @SubscribeMessage('weeklyPlans:removeItem')
  removeItem(@MessageBody() payload: WeeklyPlansRemoveItemPayload) {
    return wsRespond(() => this.weeklyPlansService.removeItem(payload.userId, payload.itemId));
  }
}
