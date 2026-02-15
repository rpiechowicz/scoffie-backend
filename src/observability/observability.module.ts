import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { OpsController } from './ops.controller';
import { RequestLoggingInterceptor } from './request-logging.interceptor';
import { RequestMetricsService } from './request-metrics.service';

@Module({
  controllers: [OpsController],
  providers: [
    RequestMetricsService,
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestLoggingInterceptor,
    },
  ],
  exports: [RequestMetricsService],
})
export class ObservabilityModule {}
