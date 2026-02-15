import { Controller, Get } from '@nestjs/common';
import { RequestMetricsService } from './request-metrics.service';
import { WsTelemetryService } from '../common/ws-telemetry.service';
import { RecipesCacheService } from '../recipes/recipes-cache.service';

@Controller('ops')
export class OpsController {
  constructor(
    private readonly metrics: RequestMetricsService,
    private readonly wsTelemetry: WsTelemetryService,
    private readonly recipesCache: RecipesCacheService,
  ) {}

  @Get('metrics')
  getMetrics() {
    return {
      http: this.metrics.snapshot(),
      ws: this.wsTelemetry.snapshot(),
      caches: {
        recipesList: this.recipesCache.stats(),
      },
    };
  }

  @Get('health')
  getHealth() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }
}
