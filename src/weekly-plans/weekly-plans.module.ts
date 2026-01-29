import { Module } from '@nestjs/common';
import { WeeklyPlansController } from './weekly-plans.controller';
import { WeeklyPlansService } from './weekly-plans.service';

@Module({
  controllers: [WeeklyPlansController],
  providers: [WeeklyPlansService],
})
export class WeeklyPlansModule {}
