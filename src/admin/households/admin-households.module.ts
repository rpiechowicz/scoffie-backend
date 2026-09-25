import { Module } from '@nestjs/common';
import { AgentModule } from '../../agent/agent.module';
import { AdminCoreModule } from '../admin-core.module';
import { AdminHouseholdsController } from './admin-households.controller';
import { AdminHouseholdsService } from './admin-households.service';

/**
 * Ekran „Gospodarstwa" panelu. `AgentModule` daje `AiUsageCountersService`
 * — miesiąc kwoty i reset sufitu liczą się TĄ SAMĄ funkcją, której używa
 * asystent, a nie jej kopią.
 */
@Module({
  imports: [AdminCoreModule, AgentModule],
  controllers: [AdminHouseholdsController],
  providers: [AdminHouseholdsService],
})
export class AdminHouseholdsModule {}
