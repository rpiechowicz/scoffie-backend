import { Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { OpsController } from './ops.controller';
import { RequestLoggingInterceptor } from './request-logging.interceptor';
import { RequestMetricsService } from './request-metrics.service';
import { RecipesModule } from '../recipes/recipes.module';
import { setWsErrorObserver } from '../common/ws-response';
import { setWsAuthObserver } from '../common/ws-socket';

@Module({
  imports: [RecipesModule],
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
export class ObservabilityModule implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly metrics: RequestMetricsService) {}

  // `wsRespond` i `actorId` są wolnymi funkcjami bez DI — metryki wpina się
  // tu, raz na proces. Zdejmowane przy zamknięciu, żeby moduł z testów nie
  // zostawiał obserwatora wskazującego na martwy serwis.
  onModuleInit(): void {
    setWsErrorObserver((code, status) =>
      this.metrics.recordWsError(code, status),
    );
    setWsAuthObserver({
      onLegacyAct: () => this.metrics.recordWsLegacyAct(),
      onPayloadMismatch: () => this.metrics.recordWsPayloadMismatch(),
    });
  }

  onModuleDestroy(): void {
    setWsErrorObserver(null);
    setWsAuthObserver(null);
  }
}
