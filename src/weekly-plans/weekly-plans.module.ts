import { Module } from '@nestjs/common';
import { WeeklyPlansGateway } from './weekly-plans.gateway';
import { WeeklyPlansService } from './weekly-plans.service';

@Module({
  providers: [WeeklyPlansService, WeeklyPlansGateway],
})
export class WeeklyPlansModule {}
