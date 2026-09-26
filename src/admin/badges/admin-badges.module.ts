import { Module } from '@nestjs/common';
import { AdminCoreModule } from '../admin-core.module';
import { DeployTrackerModule } from '../integrations/deploy-tracker.module';
import { AdminBadgesController } from './admin-badges.controller';
import { AdminBadgesService } from './admin-badges.service';

/** Liczniki paska bocznego panelu (`GET /admin/badges`). */
@Module({
  imports: [AdminCoreModule, DeployTrackerModule],
  controllers: [AdminBadgesController],
  providers: [AdminBadgesService],
})
export class AdminBadgesModule {}
