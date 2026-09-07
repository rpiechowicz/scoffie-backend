export type UpstreamBreakerOptions = {
  /** Ile błędów dostawcy w oknie otwiera bezpiecznik. */
  threshold: number;
  windowMs: number;
  /** Jak długo bezpiecznik zostaje otwarty. */
  openMs: number;
};

export const UPSTREAM_BREAKER_DEFAULTS: UpstreamBreakerOptions = {
  threshold: 5,
  windowMs: 300_000,
  openMs: 60_000,
};

/**
 * Bezpiecznik na dostawcę modelu: ≥ 5 błędów 429/5xx w 5 minut → 60 sekund
 * odmowy z `AI_UPSTREAM_PAUSED`.
 *
 * Chodzi o pieniądze i o czas użytkownika. Gdy Anthropic ma awarię albo
 * przycina nas limitem, każda kolejna tura i tak padnie — ale najpierw
 * zdejmie kwotę z licznika, zajmie lease rozmowy na czas timeoutu i pokaże
 * użytkownikowi kręciołek aż do `AI_TURN_TIMEOUT_MS`. Odmowa NA WEJŚCIU
 * (przed transakcją)
 * jest tańsza i uczciwsza: klient dostaje 503 i wie, że ma spróbować później.
 *
 * Stan w pamięci procesu — jedna instancja na Railway. Do kontenera trafia
 * fabryką z `AgentModule` (progi są argumentem konstruktora, nie zależnością).
 */
export class UpstreamBreaker {
  private readonly failures: number[] = [];
  private openUntil = 0;

  constructor(
    private readonly options: UpstreamBreakerOptions = UPSTREAM_BREAKER_DEFAULTS,
  ) {}

  isOpen(now: number = Date.now()): boolean {
    return now < this.openUntil;
  }

  retryAfterSeconds(now: number = Date.now()): number {
    return Math.max(1, Math.ceil((this.openUntil - now) / 1000));
  }

  /** `true`, gdy TEN błąd otworzył bezpiecznik (do metryki `breakerOpened`). */
  recordFailure(now: number = Date.now()): boolean {
    this.failures.push(now);
    while (
      this.failures.length > 0 &&
      now - this.failures[0] > this.options.windowMs
    ) {
      this.failures.shift();
    }
    if (this.failures.length < this.options.threshold || this.isOpen(now)) {
      return false;
    }
    this.openUntil = now + this.options.openMs;
    // Po otwarciu zaczynamy liczyć od zera — inaczej po wygaśnięciu okna
    // pierwszy kolejny błąd natychmiast otwierałby bezpiecznik ponownie.
    this.failures.length = 0;
    return true;
  }

  /** Udana tura kasuje historię — awaria się skończyła. */
  recordSuccess(): void {
    this.failures.length = 0;
  }

  reset(): void {
    this.failures.length = 0;
    this.openUntil = 0;
  }
}
