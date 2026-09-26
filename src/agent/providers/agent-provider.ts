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

/** Faza strumienia z modelu, o której warto powiedzieć telefonowi. */
export type AgentStreamActivity = 'reasoning' | 'writing';

/**
 * Zużycie JEDNEGO wywołania API, meldowane zaraz po nim (`onUsage`).
 *
 * Od 26.09.2026 księga `AiUsage` ma wiersz na wywołanie, a nie na turę: koszt
 * trafia do bazy w chwili, w której powstał, więc przeżywa timeout, „Stop"
 * spoza procesu, restart i domknięcie tury przez kogoś innego. `callIndex`
 * (0, 1, …) jest kluczem idempotencji — ten sam numer zapisany dwa razy nie
 * dubluje kosztu.
 */
export type AgentProviderCall = {
  callIndex: number;
  model: string;
  effort: AiEffort;
  usage: AgentProviderUsage;
  /** `stop_reason` tego wywołania z API (`tool_use`, `end_turn`, …). */
  stopReason: string | null;
  latencyMs: number | null;
  /**
   * Ile żądań złożyło się na wiersz — przy prawdziwym wywołaniu zawsze 1
   * (brak pola = 1). Większe tylko w zapisie zastępczym runnera dla
   * dostawcy, który nie melduje wywołań.
   */
  apiCalls?: number | null;
};

/** Odpowiedź księgi na zameldowane wywołanie. */
export type AgentUsageVerdict = {
  /**
   * Któryś sufit kosztu (dom: doba/miesiąc, instalacja: doba) jest już
   * osiągnięty. Dostawca kończy wtedy pętlę narzędzi ostatnim słowem bez
   * narzędzi (`stopReason: budget_ceiling`) zamiast wydawać dalej.
   */
  budgetExceeded: boolean;
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
  /**
   * Model dostał wyniki narzędzi i zaczyna nad nimi myśleć — dostawca woła to
   * tuż PRZED kolejnym żądaniem do API. Runner zapisuje wtedy krok postępu
   * `think`, żeby wskaźnik na telefonie nie stał przez pół minuty na nazwie
   * narzędzia, które już się skończyło. Opcjonalne i best-effort: brak
   * albo błąd nie zmienia przebiegu tury.
   */
  onThinking?: () => Promise<void>;
  /**
   * Co model robi w strumieniu, zanim pojawi się cokolwiek innego:
   * `reasoning` = pierwszy blok myślenia w tym wywołaniu API, `writing` =
   * pierwszy fragment tekstu. Raz na wywołanie i rodzaj. Runner zapisuje
   * z tego kroki przejściowe, żeby wskaźnik na telefonie zmieniał się także
   * w tych 10–40 s, w których nie ma ani narzędzia, ani litery odpowiedzi.
   * Opcjonalne i best-effort jak `onThinking`.
   */
  onActivity?: (activity: AgentStreamActivity) => Promise<void> | void;
  /**
   * Narastający tekst odpowiedzi w trakcie generowania (cały dotychczasowy,
   * nie przyrost). Dostawca woła to przy każdym fragmencie tekstu z modelu
   * i z PUSTYM tekstem na starcie każdego wywołania — tekst z rundy, która
   * skończyła się narzędziem, nie jest odpowiedzią. Synchroniczne i tanie:
   * dławienie i zapis to sprawa runnera. Opcjonalne, best-effort.
   */
  onDraft?: (text: string) => void;
  /**
   * Zużycie każdego wywołania API, zaraz po nim — także tego, po którym
   * tura padnie (odmowa modelu, błąd następnej rundy). Dostawca czeka na
   * odpowiedź, bo niesie ona werdykt budżetu. Implementacja runnera nie
   * rzuca; dostawca bez tego pola zostawia runnerowi zapis zastępczy
   * (jeden zbiorczy wiersz po turze).
   */
  onUsage?: (call: AgentProviderCall) => Promise<AgentUsageVerdict>;
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
  /** Czasy kolejnych wywołań API; brak pola = dostawca nie mierzy. */
  timings?: AgentCallTiming[];
};

/**
 * Na co poszedł czas JEDNEGO wywołania API — pomiar, nie rozliczenie.
 *
 * Benchmark z 7.09.2026 (168 tur) tłumaczył czas tury w 94 % trzema
 * liczbami: ~1,5 s na rundę, ~10 ms na token wyjścia i ~2 s stałej. Tokeny
 * wyjścia to jednak trzy różne rzeczy — myślenie, wejście narzędzia (cały
 * tydzień w `propose_week_plan`) i tekst — a z `usage` nie da się ich
 * rozdzielić. Czas bloków w strumieniu da się, i to on mówi, co skracać.
 */
export type AgentCallTiming = {
  model: string;
  /** Od wysłania żądania do końca strumienia. */
  totalMs: number;
  /** Do początku pierwszego bloku treści; `null` = strumień bez bloków. */
  firstBlockMs: number | null;
  /** Suma czasu bloków myślenia. */
  thinkingMs: number;
  /** Suma czasu bloków `tool_use` — model pisze wejście narzędzia. */
  toolInputMs: number;
  /** Suma czasu bloków tekstu. */
  textMs: number;
  outputTokens: number;
  /** Narzędzia, o które model poprosił w tym wywołaniu. */
  tools: string[];
  /** Wykonanie tych narzędzi po naszej stronie; `null` = nie było narzędzi. */
  toolsRunMs: number | null;
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
