import { Global, Module } from '@nestjs/common';
import { WsTelemetryService } from './ws-telemetry.service';

@Global()
@Module({
  providers: [WsTelemetryService],
  exports: [WsTelemetryService],
})
export class CommonModule {}
