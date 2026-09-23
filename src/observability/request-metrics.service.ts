import { Injectable } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';

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
  // Błędy z acków WebSocketu, per kod — HTTP-owe liczniki wyżej ich nie
  // widzą, a to po sockecie idzie prawie cały ruch aplikacji.
  private wsErrorsTotal = 0;
  private readonly wsErrorsByCode = new Map<string, number>();
  // Auth WebSocketu (Faza 0): ile handshake'ów z tokenem, ile legacy (bez
  // tokenu, tryb soft), ile odrzuconych i dlaczego; ile akcji poszło po
  // tożsamości z payloadu. `legacy` = 0 przez dłuższy czas to sygnał, że
  // stare buildy iOS zniknęły i można przełączyć WS_AUTH_MODE=strict.
  private readonly wsAuthHandshakes = { token: 0, legacy: 0, rejected: 0 };
  private readonly wsAuthRejectedByReason = new Map<string, number>();
  private wsAuthLegacyActs = 0;
  private wsAuthPayloadMismatch = 0;
  // 429 z throttlera: guard biegnie PRZED interceptorem logującym, więc
  // `record()` tych odpowiedzi nie widzi — liczone osobno, per trasa.
  private throttledTotal = 0;
  private readonly throttledByRoute = new Map<string, number>();

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

  recordWsError(code: string, status: number): void {
    this.wsErrorsTotal += 1;
    // Do Sentry też: ślady HTTP nie widzą ruchu po sockecie, a to jego
    // większość. `code` to zamknięty słownik z `error-contract`.
    Sentry.metrics.count('scoffie.ws.error', 1, {
      attributes: { code, status },
    });
    this.wsErrorsByCode.set(code, (this.wsErrorsByCode.get(code) ?? 0) + 1);
  }

  recordWsHandshake(
    outcome: 'token' | 'legacy' | 'rejected',
    reason?: string,
  ): void {
    this.wsAuthHandshakes[outcome] += 1;
    Sentry.metrics.count('scoffie.ws.handshake', 1, {
      attributes: { outcome, reason: reason ?? 'none' },
    });
    if (outcome === 'rejected') {
      const key = reason ?? 'unknown';
      this.wsAuthRejectedByReason.set(
        key,
        (this.wsAuthRejectedByReason.get(key) ?? 0) + 1,
      );
    }
  }

  recordWsLegacyAct(): void {
    this.wsAuthLegacyActs += 1;
  }

  recordWsPayloadMismatch(): void {
    this.wsAuthPayloadMismatch += 1;
  }

  recordThrottled(routeKey: string): void {
    this.throttledTotal += 1;
    Sentry.metrics.count('scoffie.http.throttled', 1, {
      attributes: { route: routeKey },
    });
    this.throttledByRoute.set(
      routeKey,
      (this.throttledByRoute.get(routeKey) ?? 0) + 1,
    );
  }

  snapshot() {
    const routes = Array.from(this.routeStats.entries())
      .map(([route, stats]) => ({
        route,
        count: stats.count,
        errors: stats.errors,
        avgDurationMs: Number(
          (stats.totalDurationMs / Math.max(stats.count, 1)).toFixed(2),
        ),
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
      wsErrors: {
        total: this.wsErrorsTotal,
        byCode: Object.fromEntries(this.wsErrorsByCode.entries()),
      },
      wsAuth: {
        handshakes: { ...this.wsAuthHandshakes },
        rejectedByReason: Object.fromEntries(
          this.wsAuthRejectedByReason.entries(),
        ),
        legacyActs: this.wsAuthLegacyActs,
        payloadMismatch: this.wsAuthPayloadMismatch,
      },
      throttled: {
        total: this.throttledTotal,
        byRoute: Object.fromEntries(this.throttledByRoute.entries()),
      },
    };
  }

  private statusToBucket(
    statusCode: number,
  ): '2xx' | '3xx' | '4xx' | '5xx' | 'other' {
    if (statusCode >= 200 && statusCode < 300) return '2xx';
    if (statusCode >= 300 && statusCode < 400) return '3xx';
    if (statusCode >= 400 && statusCode < 500) return '4xx';
    if (statusCode >= 500 && statusCode < 600) return '5xx';
    return 'other';
  }
}
