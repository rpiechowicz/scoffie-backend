import { AiProvider, AiEffort } from '../../config/agent-env';
import { SystemBlock } from '../agent-system-prompt';
import { AgentToolResult } from '../tools/agent-tool-executor';
import { AgentToolDefinition } from '../tools/agent-tools';

export type AgentProviderMessage = {
  role: 'USER' | 'ASSISTANT';
  text: string;
};

export type AgentProviderRequest = {
  model: string;
  effort: AiEffort;
  /** Bloki systemowe w kolejności podyktowanej przez cache — patrz `agent-system-prompt.ts`. */
  system: SystemBlock[];
  messages: AgentProviderMessage[];
  tools: readonly AgentToolDefinition[];
  /**
   * Wykonanie narzędzia. Dostawca NIE zna domeny ani tożsamości użytkownika —
   * dostaje domknięcie przygotowane przez runnera tury. Dzięki temu warstwa
   * transportowa nie ma jak sięgnąć do bazy z pominięciem bramek.
   */
  executeTool: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<AgentToolResult>;
  /** Przerwanie tury po `AI_TURN_TIMEOUT_MS` — dostawca MUSI go respektować. */
  signal: AbortSignal;
  /**
   * Sufit kosztu jednej tury w USD (`AI_MAX_TURN_COST_USD`); `null` = bez
   * sufitu. Po przekroczeniu dostawca kończy pętlę narzędzi odpowiedzią bez
   * narzędzi zamiast kręcić się do limitu rund.
   */
  maxTurnCostUsd: number | null;
};

export type AgentProviderUsage = {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** Koszt w mikrodolarach — liczby całkowite, bo `AiUsage.costMicroUsd` to Int. */
  costMicroUsd: number;
};

export type AgentProviderResult = {
  text: string;
  stopReason: string | null;
  usage: AgentProviderUsage;
  /** Ile razy model odpytał API w tej turze (1 + liczba rund narzędziowych). */
  apiCalls: number;
};

export interface AgentProvider {
  readonly name: AiProvider;
  run(request: AgentProviderRequest): Promise<AgentProviderResult>;
}

/**
 * Błąd dostawcy z informacją, czy warto ponowić.
 *
 * `retryable` (429, 5xx, sieć) znaczy dwie rzeczy naraz: kwota wraca do
 * licznika (użytkownik nie płaci za awarię po naszej stronie łańcucha) i
 * błąd liczy się do bezpiecznika. `retryable: false` (zły prompt, odmowa
 * modelu) tury nie zwraca — to nie jest awaria.
 */
export class AgentProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    /**
     * Zużycie, które zdążyło narosnąć PRZED błędem.
     *
     * Nieudana tura po sześciu rundach narzędzi kosztowała tyle samo, co
     * udana — bez tego pola księga `AiUsage` pokazywałaby zero i budżet
     * dobowy nie widziałby wydanych pieniędzy.
     */
    readonly usage?: AgentProviderUsage,
  ) {
    super(message);
    this.name = 'AgentProviderError';
  }
}
