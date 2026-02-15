import { Injectable } from '@nestjs/common';

type RouteStats = {
  count: number;
  errors: number;
  totalDurationMs: number;
  maxDurationMs: number;
};

@Injectable()
export class RequestMetricsService {
  private readonly startedAt = Date.now();
  private totalRequests = 0;
  private totalErrors = 0;
  private readonly statusClassCounts: Record<string, number> = {
    '2xx': 0,
    '3xx': 0,
    '4xx': 0,
    '5xx': 0,
    other: 0,
  };
  private readonly routeStats = new Map<string, RouteStats>();

  record(routeKey: string, statusCode: number, durationMs: number): void {
    this.totalRequests += 1;

    if (statusCode >= 500) this.totalErrors += 1;

    const bucket = this.statusToBucket(statusCode);
    this.statusClassCounts[bucket] = (this.statusClassCounts[bucket] ?? 0) + 1;

    const existing = this.routeStats.get(routeKey) ?? {
      count: 0,
      errors: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
    };

    existing.count += 1;
    if (statusCode >= 500) {
      existing.errors += 1;
    }
    existing.totalDurationMs += durationMs;
    existing.maxDurationMs = Math.max(existing.maxDurationMs, durationMs);

    this.routeStats.set(routeKey, existing);
  }

  snapshot() {
    const routes = Array.from(this.routeStats.entries())
      .map(([route, stats]) => ({
        route,
        count: stats.count,
        errors: stats.errors,
        avgDurationMs: Number((stats.totalDurationMs / Math.max(stats.count, 1)).toFixed(2)),
        maxDurationMs: Number(stats.maxDurationMs.toFixed(2)),
      }))
      .sort((a, b) => b.count - a.count);

    return {
      generatedAt: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      totals: {
        requests: this.totalRequests,
        errors5xx: this.totalErrors,
      },
      statuses: { ...this.statusClassCounts },
      routes,
    };
  }

  private statusToBucket(statusCode: number): '2xx' | '3xx' | '4xx' | '5xx' | 'other' {
    if (statusCode >= 200 && statusCode < 300) return '2xx';
    if (statusCode >= 300 && statusCode < 400) return '3xx';
    if (statusCode >= 400 && statusCode < 500) return '4xx';
    if (statusCode >= 500 && statusCode < 600) return '5xx';
    return 'other';
  }
}
