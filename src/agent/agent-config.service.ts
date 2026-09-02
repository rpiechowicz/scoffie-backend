import { HttpStatus, Injectable } from '@nestjs/common';
import { AgentEnv, readAgentEnv } from '../config/agent-env';
import { AppException } from '../common/app-exception';
import { LEGAL_DOCUMENT_VERSIONS } from '../common/legal-documents';
import { ConsentsService } from '../consents/consents.service';
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
    private readonly consents: ConsentsService,
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
   * zostają otwarte — prawo do własnych danych nie zależy od listy ani zgody.
   *
   * Dwa sprawdzenia, w tej kolejności:
   * 1. `AI_ALLOWED_USERS` (pusta = wszyscy). Konto spoza listy dostaje to samo
   *    503 `AI_DISABLED`, co wyłączony asystent — celowo: wydany build iOS ma
   *    dla tego kodu kopię i blokadę pola. `details` rozróżnia powód w logach.
   * 2. Przy `AI_CONSENT_REQUIRED=true` — ważna zgoda AI_ASSISTANT tej osoby
   *    (art. 9 RODO: alergie i dieta to dane o zdrowiu). Brak = 403
   *    `AI_CONSENT_REQUIRED`, klient pokazuje ekran zgody.
   */
  async assertUserAllowed(userId: string, env: AgentEnv = this.read()) {
    if (env.allowedUsers.length > 0) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true },
      });
      const candidates = [user?.id, user?.email]
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.toLowerCase());
      if (!candidates.some((value) => env.allowedUsers.includes(value))) {
        throw this.disabled('not_allowed');
      }
    }

    if (env.consentRequired) {
      // Dwie zgody naraz: na wysyłanie danych do modelu (art. 9) i na
      // deklarację 16 lat (art. 8). Druga była dotąd tylko zdefiniowana —
      // egzekwował ją wyłącznie klient, czyli nikt.
      const [ai, age] = await Promise.all([
        this.consents.hasValid(userId, 'AI_ASSISTANT'),
        this.consents.hasValid(userId, 'AGE_16'),
      ]);
      if (!ai || !age) {
        this.metrics.recordRejected('disabled');
        throw new AppException(
          'AI_CONSENT_REQUIRED',
          'Zanim zaczniesz rozmawiać z asystentem, potwierdź zgodę w Ustawieniach.',
          HttpStatus.FORBIDDEN,
          [
            `documentVersion:${LEGAL_DOCUMENT_VERSIONS.AI_ASSISTANT}`,
            ...(ai ? [] : ['missing:AI_ASSISTANT']),
            ...(age ? [] : ['missing:AGE_16']),
          ],
        );
      }
    }
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
