import { Injectable, Logger } from '@nestjs/common';

/** Ten sam klucz nie budzi operatora częściej niż raz na sześć godzin. */
const DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Alert dla operatora — jeden webhook, zero zależności.
 *
 * Do audytu z 2.09.2026 jedyną obserwowalnością były liczniki w pamięci
 * procesu (`/ops/metrics`, zerowane przy deployu) i logi Railway: zatrzymanie
 * budżetu AI (asystent milczy do północy UTC) czy otwarcie bezpiecznika
 * dostawcy zauważał dopiero użytkownik. `OPS_ALERT_WEBHOOK_URL` (Discord,
 * Slack, ntfy, cokolwiek przyjmuje POST z JSON-em) dostaje jedno zdanie po
 * polsku; pusta zmienna = alerty wyłączone, jak wszystko inne bez domyślnej.
 *
 * Nigdy nie rzuca i nigdy nie blokuje ścieżki żądania dłużej niż timeout —
 * alert, który wywraca turę, jest gorszy niż brak alertu. Ładunek niesie
 * `content` (Discord) i `text` (Slack/ntfy) z tym samym zdaniem.
 */
@Injectable()
export class OpsAlertService {
  private readonly logger = new Logger(OpsAlertService.name);
  private readonly lastSent = new Map<string, number>();

  constructor(
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * @param key   deduplikacja — np. `ai-budget-paused:2026-09-02`
   * @param text  jedno zdanie po polsku, bez danych osobowych i bez treści rozmów
   */
  async notify(key: string, text: string): Promise<boolean> {
    const url = (process.env.OPS_ALERT_WEBHOOK_URL ?? '').trim();
    if (!url) return false;

    const at = this.now();
    const previous = this.lastSent.get(key);
    if (previous !== undefined && at - previous < DEDUPE_WINDOW_MS) {
      return false;
    }
    this.lastSent.set(key, at);
    this.prune(at);

    const message = `[Scoffie] ${text}`;
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: message, text: message }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn(`webhook alertu odpowiedział ${response.status}`);
        return false;
      }
      return true;
    } catch (error) {
      this.logger.warn(
        `webhook alertu nie zadziałał: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private prune(at: number): void {
    for (const [key, sentAt] of this.lastSent) {
      if (at - sentAt >= DEDUPE_WINDOW_MS) this.lastSent.delete(key);
    }
  }
}
