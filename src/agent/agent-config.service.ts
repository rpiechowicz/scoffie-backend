import { HttpStatus, Injectable } from '@nestjs/common';
import { AgentEnv, readAgentEnv } from '../config/agent-env';
import { AppException } from '../common/app-exception';
import { AgentMetricsService } from '../observability/agent-metrics.service';

/**
 * Konfiguracja asystenta w jednym miejscu — czytana z env PER WYWOŁANIE.
 *
 * Nie `ConfigService` i nie pole ustawiane w konstruktorze: flaga
 * `AI_ENABLED` jest przełącznikiem wdrożeniowym (Railway → restart bez
 * builda), a e2e włącza asystenta w tym samym procesie, w którym stoi reszta
 * suit. Ten sam wzorzec, co `resolveWsAuthMode` w kroku 1.
 */
@Injectable()
export class AgentConfigService {
  constructor(private readonly metrics: AgentMetricsService) {}

  read(): AgentEnv {
    return readAgentEnv();
  }

  /**
   * Bramka wejściowa każdego endpointu `/agent`. Wyłączony asystent to 503
   * (`AI_DISABLED`), a nie 404 — klient ma wiedzieć, że funkcja istnieje,
   * tylko jest teraz niedostępna, i nie chować przycisku na stałe.
   *
   * Brak klucza przy `AI_PROVIDER=anthropic` traktujemy jak wyłączony:
   * `assert-env` już o tym krzyknął przy starcie, a tura i tak padłaby po
   * pierwszym wywołaniu dostawcy — lepiej odmówić, niż policzyć kwotę.
   */
  assertEnabled(): AgentEnv {
    const env = this.read();
    if (!env.enabled) {
      this.metrics.recordRejected('disabled');
      throw new AppException(
        'AI_DISABLED',
        'Asystent jest teraz niedostępny.',
        HttpStatus.SERVICE_UNAVAILABLE,
        ['disabled'],
      );
    }
    if (env.provider === 'anthropic' && !env.apiKeyPresent) {
      this.metrics.recordRejected('disabled');
      throw new AppException(
        'AI_DISABLED',
        'Asystent jest teraz niedostępny.',
        HttpStatus.SERVICE_UNAVAILABLE,
        ['provider_not_configured'],
      );
    }
    return env;
  }
}
