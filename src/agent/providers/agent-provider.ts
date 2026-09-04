import { AiProvider, AiEffort } from '../../config/agent-env';
import { SystemBlock } from '../agent-system-prompt';
import { AgentToolResult } from '../tools/agent-tool-executor';
import { AgentToolDefinition } from '../tools/agent-tools';

export type AgentProviderMessage = {
  role: 'USER' | 'ASSISTANT';
  text: string;
};

/**
 * Przekazanie tury innemu modelowi w połowie pętli narzędzi.
 *
 * Gdy model wywoła narzędzie `tool`, od NASTĘPNEJ rundy żądania idą do
 * `model` z listą `tools`. Historia rund zostaje — nowy model widzi, co
 * poprzedni już sprawdził. Koszt każdej rundy liczy się po stawce modelu,
 * który ją wykonał.
 */
export type AgentProviderHandoff = {
  tool: string;
  model: string;
  /** Wysiłek planisty — faza CHAT ma swój własny (`AI_EFFORT_TOOLS`). */
  effort: AiEffort;
  tools: readonly AgentToolDefinition[];
};

/**
 * Zużycie jednej FAZY tury (model + wysiłek).
 *
 * Bez tego podziału księga `AiUsage` zapisywała całą turę pod modelem, który
 * dał ostatnie słowo — czyli rundy taniego modelu księgowały się pod
 * planistą, a raport kosztów pokazywał, że tani model nic nie oszczędza.
 */
export type AgentPhaseUsage = {
  model: string;
  effort: AiEffort;
  apiCalls: number;
  usage: AgentProviderUsage;
};

export type AgentProviderRequest = {
  model: string;
  effort: AiEffort;
  /** Podział na tańszy i mocniejszy model; brak = jeden model na całą turę. */
  handoff?: AgentProviderHandoff | null;
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
  /**
   * Model, który dał ostatnie słowo. Przy przekazaniu to `handoff.model`;
   * bez przekazania — `request.model`. Brak pola = jak `request.model`.
   */
  model?: string;
  /** Ile razy model odpytał API w tej turze (1 + liczba rund narzędziowych). */
  apiCalls: number;
  /** Rozbicie na fazy; pusta tablica = dostawca nie rozróżnia faz. */
  phases?: AgentPhaseUsage[];
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
    /** Ile żądań poszło do dostawcy przed błędem — do metryk. */
    readonly apiCalls?: number,
    /** Rozbicie na fazy tego, co zdążyło się wydać przed błędem. */
    readonly phases?: AgentPhaseUsage[],
  ) {
    super(message);
    this.name = 'AgentProviderError';
  }
}
