import { Controller, Get, UseGuards } from '@nestjs/common';
import { OpsTokenGuard } from './ops-token.guard';
import { RequestMetricsService } from './request-metrics.service';
import { AgentMetricsService } from './agent-metrics.service';
import { WsTelemetryService } from '../common/ws-telemetry.service';
import { RecipesCacheService } from '../recipes/recipes-cache.service';
import { PrismaService } from '../prisma/prisma.service';

@Controller('ops')
export class OpsController {
  constructor(
    private readonly metrics: RequestMetricsService,
    private readonly agentMetrics: AgentMetricsService,
    private readonly wsTelemetry: WsTelemetryService,
    private readonly recipesCache: RecipesCacheService,
    private readonly prisma: PrismaService,
  ) {}

  // Nagłówek `x-ops-token` = `OPS_TOKEN` — patrz `OpsTokenGuard`.
  @Get('metrics')
  @UseGuards(OpsTokenGuard)
  async getMetrics() {
    return {
      http: this.metrics.snapshot(),
      ws: this.wsTelemetry.snapshot(),
      agent: this.agentMetrics.snapshot(),
      caches: {
        recipesList: this.recipesCache.stats(),
      },
      // Stan migracji obok metryk, a nie w `/ops/health`: health jest sondą
      // żywotności i nie ma prawa zależeć od bazy.
      migrations: await this.migrationsSnapshot(),
    };
  }

  @Get('health')
  getHealth() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      // Który commit tu naprawdę chodzi.
      //
      // Bez tego pytanie „czy produkcja ma już tę poprawkę" nie ma odpowiedzi
      // inaczej niż przez zgadywanie po zachowaniu aplikacji — a to była
      // dokładnie ta sytuacja, w której zapisane porcje wracały do jedynki
      // i nie dało się orzec, czy wina jest w kodzie, czy w tym, że kod
      // jeszcze nie dojechał. Railway wystawia `RAILWAY_GIT_COMMIT_SHA` sam;
      // `APP_COMMIT` jest furtką dla innych środowisk.
      commit:
        process.env.APP_COMMIT ??
        process.env.RAILWAY_GIT_COMMIT_SHA ??
        'unknown',
    };
  }

  /**
   * Ostatnia zastosowana migracja i ich liczba. Czytane wprost z tabeli
   * Prismy, bo to jedyne miejsce, które wie, co NAPRAWDĘ weszło do bazy —
   * obraz aplikacji może być nowszy niż schemat, i odwrotnie.
   */
  private async migrationsSnapshot(): Promise<{
    applied: number | null;
    latest: string | null;
  }> {
    try {
      const rows = await this.prisma.$queryRaw<
        { migration_name: string }[]
      >`SELECT migration_name FROM "_prisma_migrations"
        WHERE finished_at IS NOT NULL
        ORDER BY finished_at DESC`;
      return {
        applied: rows.length,
        latest: rows[0]?.migration_name ?? null,
      };
    } catch {
      // Brak tabeli (świeża baza bez migracji) albo brak połączenia — metryki
      // mają się wtedy dalej otwierać, tylko bez tej sekcji.
      return { applied: null, latest: null };
    }
  }
}
