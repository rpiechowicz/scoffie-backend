import { Controller, Get } from '@nestjs/common';
import { RequestMetricsService } from './request-metrics.service';

@Controller('ops')
export class OpsController {
  constructor(private readonly metrics: RequestMetricsService) {}

  @Get('metrics')
  getMetrics() {
    return this.metrics.snapshot();
  }

  @Get('health')
  getHealth() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }
}
