import { Module } from '@nestjs/common';
import { AdminCoreModule } from '../admin-core.module';
import { AdminFlagsController } from './admin-flags.controller';
import { AdminFlagsService } from './admin-flags.service';

/** Ekran „Flagi” i sekcja „Bety” gospodarstwa. `FeatureFlagsService` jest globalny. */
@Module({
  imports: [AdminCoreModule],
  controllers: [AdminFlagsController],
  providers: [AdminFlagsService],
})
export class AdminFlagsModule {}
