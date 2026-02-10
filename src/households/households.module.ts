import { Module } from '@nestjs/common';
import { HouseholdsGateway } from './households.gateway';
import { HouseholdsService } from './households.service';

@Module({
  providers: [HouseholdsService, HouseholdsGateway],
})
export class HouseholdsModule {}
