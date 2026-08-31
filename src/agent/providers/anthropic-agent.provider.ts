import { Injectable } from '@nestjs/common';
import {
  AgentProvider,
  AgentProviderError,
  AgentProviderRequest,
  AgentProviderResult,
} from './agent-provider';

/**
 * Szkielet dostawcy Anthropic — Faza 0 kończy się TUTAJ.
 *
 * Kroku „zawołaj model" świadomie nie ma: nie mamy jeszcze klucza API, a bez
 * niego nie da się ani zmierzyć digestu przez `count_tokens` (krok 4 Fazy 0),
 * ani dobrać modelu i effortu. Reszta toru — 202, polling, kwoty, budżet,
 * bezpiecznik, księga użycia — jest kompletna i sprawdzona stubem, więc
 * Faza 1 dokłada w tym pliku wywołanie SDK i mapowanie `usage`, nie
 * przebudowuje przepływu.
 *
 * Rzut jest `retryable: false`: to nie awaria dostawcy, tylko brak wdrożenia —
 * ponawianie i zwrot kwoty byłyby mylące, a bezpiecznik nie ma czego chronić.
 */
@Injectable()
export class AnthropicAgentProvider implements AgentProvider {
  readonly name = 'anthropic' as const;

  run(_request: AgentProviderRequest): Promise<AgentProviderResult> {
    return Promise.reject(
      new AgentProviderError(
        'Dostawca anthropic nie jest jeszcze wdrożony (Faza 1)',
        false,
      ),
    );
  }
}
