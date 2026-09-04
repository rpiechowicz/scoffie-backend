import { Injectable } from '@nestjs/common';
import { readAgentEnv } from '../../config/agent-env';
import {
  AgentProvider,
  AgentProviderError,
  AgentProviderRequest,
  AgentProviderResult,
} from './agent-provider';

/** Markery w treści wiadomości — wymuszają błąd w testach, bez mockowania DI. */
export const STUB_UPSTREAM_ERROR_MARKER = '[[upstream-error]]';
export const STUB_ERROR_MARKER = '[[error]]';
/**
 * Wymusza JEDNO wywołanie narzędzia, zanim stub odpowie.
 *
 * Bez tego cała ścieżka postępu tury (`AgentTurn.progress`) była w e2e martwa:
 * stub odpowiadał od razu, więc nikt nigdy nie sprawdził, czy klient dostaje
 * kroki, których obiecuje mu kontrakt. `get_household_context` nie bierze
 * żadnych argumentów i niczego nie zapisuje.
 */
export const STUB_TOOL_MARKER = '[[tool]]';
/**
 * Wymusza PROPOZYCJĘ tygodnia: `[[propose:<recipeId>:<YYYY-MM-DD>]]`.
 *
 * Identyfikator i tydzień są w markerze, a nie zgadywane z promptu, bo stub
 * ma sprawdzać tor tury, a nie umieć czytać katalogu. Dzięki temu e2e
 * przechodzi całą ścieżkę propozycji — narzędzie, kartę, wiadomość z `kind`
 * i przypięcie `messageId` — bez ani jednego wywołania modelu.
 */
export const STUB_PROPOSE_PATTERN =
  /\[\[propose:([0-9a-fA-F-]{36}):(\d{4}-\d{2}-\d{2})\]\]/;

/**
 * Dostawca `stub` (`AI_PROVIDER=stub`) — cały tor tury bez ani jednego
 * wywołania modelu: 202, polling, lease, kwota, bezpiecznik, księga użycia.
 *
 * e2e nie może zależeć od Anthropica (klucza jeszcze nie ma, a płatny
 * dostawca w CI to zły pomysł), a mock w kontenerze DI nie sprawdziłby tego,
 * co naprawdę robi runner. Stub jest więc częścią produkcyjnego kodu,
 * dostępną tylko przy jawnym `AI_PROVIDER=stub`.
 *
 * `AI_STUB_DELAY_MS` rozciąga odpowiedź — tak testuje się 409 na zajętej
 * rozmowie i przerwanie po timeoutcie.
 */
@Injectable()
export class StubAgentProvider implements AgentProvider {
  readonly name = 'stub' as const;

  async run(request: AgentProviderRequest): Promise<AgentProviderResult> {
    const lastUserText =
      [...request.messages].reverse().find((m) => m.role === 'USER')?.text ??
      '';

    await this.delay(readAgentEnv().stubDelayMs, request.signal);

    if (lastUserText.includes(STUB_UPSTREAM_ERROR_MARKER)) {
      throw new AgentProviderError('stub: symulowany błąd dostawcy', true, 503);
    }
    if (lastUserText.includes(STUB_ERROR_MARKER)) {
      throw new AgentProviderError('stub: symulowany błąd tury', false);
    }

    if (lastUserText.includes(STUB_TOOL_MARKER)) {
      await request.executeTool('get_household_context', {});
    }

    const propose = STUB_PROPOSE_PATTERN.exec(lastUserText);
    if (propose) {
      await request.executeTool('propose_week_plan', {
        week_start: propose[2],
        slots: [
          { day_of_week: 'MON', meal_type: 'DINNER', recipe: propose[1] },
        ],
      });
    }

    const text = `[stub] ${lastUserText}`.slice(0, 4000);
    const usage = {
      // Prymitywne, ale niezerowe: e2e sprawdza, że księga użycia i licznik
      // kosztu dostają realne liczby, a nie same zera.
      inputTokens: lastUserText.length,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: text.length,
      costMicroUsd: 0,
    };
    return {
      text,
      stopReason: 'end_turn',
      apiCalls: 1,
      usage,
      // Jedna faza: stub nie przekazuje pałeczki, ale księga per faza ma
      // dostać wiersz także tutaj (e2e sprawdza `AiUsage`).
      phases: [
        {
          model: request.model,
          effort: request.effort,
          apiCalls: 1,
          usage,
        },
      ],
    };
  }

  private delay(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new AgentProviderError('stub: tura przerwana', true));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
