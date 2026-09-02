import { HttpStatus, Injectable } from '@nestjs/common';
import { AgentEnv, readAgentEnv } from '../config/agent-env';
import { AppException } from '../common/app-exception';
import { AgentMetricsService } from '../observability/agent-metrics.service';
import { PrismaService } from '../prisma/prisma.service';

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
  constructor(
    private readonly metrics: AgentMetricsService,
    private readonly prisma: PrismaService,
  ) {}

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
      throw this.disabled('disabled');
    }
    if (env.provider === 'anthropic' && !env.apiKeyPresent) {
      throw this.disabled('provider_not_configured');
    }
    return env;
  }

  /**
   * Druga bramka, tylko tam, gdzie zaczyna się koszt: założenie rozmowy
   * i wysłanie wiadomości. Odczyt historii, kasowanie rozmów i pamięci
   * zostają otwarte — prawo do własnych danych nie zależy od listy.
   *
   * Pusta `AI_ALLOWED_USERS` = wszyscy (jak dotąd). Konto spoza listy dostaje
   * to samo 503 `AI_DISABLED`, co przy wyłączonym asystencie — celowo:
   * wydany build iOS ma dla tego kodu kopię i blokadę pola, a nowy kod
   * wymagałby nowej kopii na Macu. `details` rozróżnia powód w logach.
   */
  async assertUserAllowed(userId: string, env: AgentEnv = this.read()) {
    if (env.allowedUsers.length === 0) return;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true },
    });
    const candidates = [user?.id, user?.email]
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.toLowerCase());
    if (candidates.some((value) => env.allowedUsers.includes(value))) return;
    throw this.disabled('not_allowed');
  }

  private disabled(detail: string): AppException {
    this.metrics.recordRejected('disabled');
    return new AppException(
      'AI_DISABLED',
      'Asystent jest teraz niedostępny.',
      HttpStatus.SERVICE_UNAVAILABLE,
      [detail],
    );
  }
}
