import { Get } from '@nestjs/common';
import { AdminController } from '../admin-controller.decorator';
import { AdminRequires } from '../admin.decorators';
import type { TrafficState } from '../contract';
import { AdminTrafficService } from './admin-traffic.service';

@AdminController('traffic')
export class AdminTrafficController {
  constructor(private readonly traffic: AdminTrafficService) {}

  @Get()
  @AdminRequires('ops.read')
  data(): Promise<TrafficState> {
    return this.traffic.traffic();
  }
}
