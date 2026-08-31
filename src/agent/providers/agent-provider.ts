import { AiProvider } from '../../config/agent-env';

export type AgentProviderMessage = {
  role: 'USER' | 'ASSISTANT';
  text: string;
};

export type AgentProviderRequest = {
  model: string;
  messages: AgentProviderMessage[];
  /** Przerwanie tury po `AI_TURN_TIMEOUT_MS` — dostawca MUSI go respektować. */
  signal: AbortSignal;
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
  ) {
    super(message);
    this.name = 'AgentProviderError';
  }
}
