import { Injectable } from '@nestjs/common';
import type { SentryData } from '../contract';

/**
 * Ostatni pełny odczyt Sentry z przebiegu alertów (co 10 min) — zasiewa
 * pamięć ekranu „System”, żeby pierwsze wejście po starcie procesu nie
 * czekało na Sentry. Odpowiednik `DeployTrackerService.fullSnapshot()` dla
 * Railwaya. Jedna instancja Railway — pamięć procesu wystarcza.
 */
@Injectable()
export class SentrySnapshotService {
  private snapshot: { data: SentryData; at: number } | null = null;

  /** Starszy od zapamiętanego nie nadpisuje. */
  remember(data: SentryData, at: number = Date.now()): void {
    if (this.snapshot && this.snapshot.at > at) return;
    this.snapshot = { data, at };
  }

  last(): { data: SentryData; at: number } | null {
    return this.snapshot;
  }
}
