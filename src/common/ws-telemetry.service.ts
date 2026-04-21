import { Injectable } from '@nestjs/common';

type GatewayStats = {
  activeConnections: number;
  totalConnections: number;
  totalDisconnections: number;
};

@Injectable()
export class WsTelemetryService {
  private readonly gateways = new Map<string, GatewayStats>();

  onConnect(gateway: string): void {
    const stats = this.gateways.get(gateway) ?? {
      activeConnections: 0,
      totalConnections: 0,
      totalDisconnections: 0,
    };
    stats.activeConnections += 1;
    stats.totalConnections += 1;
    this.gateways.set(gateway, stats);
  }

  onDisconnect(gateway: string): void {
    const stats = this.gateways.get(gateway) ?? {
      activeConnections: 0,
      totalConnections: 0,
      totalDisconnections: 0,
    };
    stats.activeConnections = Math.max(0, stats.activeConnections - 1);
    stats.totalDisconnections += 1;
    this.gateways.set(gateway, stats);
  }

  snapshot() {
    const gateways = Array.from(this.gateways.entries())
      .map(([gateway, stats]) => ({
        gateway,
        ...stats,
      }))
      .sort((a, b) => a.gateway.localeCompare(b.gateway));

    const totals = gateways.reduce(
      (acc, item) => {
        acc.activeConnections += item.activeConnections;
        acc.totalConnections += item.totalConnections;
        acc.totalDisconnections += item.totalDisconnections;
        return acc;
      },
      { activeConnections: 0, totalConnections: 0, totalDisconnections: 0 },
    );

    return {
      totals,
      gateways,
    };
  }
}
