import { Get, Query } from '@nestjs/common';
import { AdminController } from '../admin-controller.decorator';
import { AdminRequires } from '../admin.decorators';
import type { GrowthData } from '../contract';
import { GrowthQueryDto } from './admin-growth.dto';
import { AdminGrowthService } from './admin-growth.service';

/** `GET /admin/growth` — ekran „Wzrost”: lejek, kohorty, DAU/WAU/MAU. */
@AdminController('growth')
export class AdminGrowthController {
  constructor(private readonly growthService: AdminGrowthService) {}

  @Get()
  @AdminRequires('growth.read')
  growth(@Query() query: GrowthQueryDto): Promise<GrowthData> {
    return this.growthService.growth(query.period ?? '30');
  }
}
