import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WeeklyPlansController } from './weekly-plans.controller';
import { WeeklyPlansService } from './weekly-plans.service';

@Module({
  imports: [AuthModule],
  controllers: [WeeklyPlansController],
  providers: [WeeklyPlansService],
})
export class WeeklyPlansModule {}
