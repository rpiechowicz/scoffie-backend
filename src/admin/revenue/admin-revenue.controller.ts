import { Get, Query } from '@nestjs/common';
import { AdminController } from '../admin-controller.decorator';
import { AdminRequires } from '../admin.decorators';
import type { RevenueData } from '../contract';
import { RevenueQueryDto } from './admin-revenue.dto';
import { AdminRevenueService } from './admin-revenue.service';

/** Wypłaty z Apple (ROADMAPA §5.6) — tylko odczyt z bazy. */
@AdminController('revenue')
export class AdminRevenueController {
  constructor(private readonly revenue: AdminRevenueService) {}

  @Get()
  @AdminRequires('revenue.read')
  data(@Query() query: RevenueQueryDto): Promise<RevenueData> {
    return this.revenue.data(query.period ?? '30');
  }
}
