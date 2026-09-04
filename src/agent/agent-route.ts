import { AgentEnv, AiEffort } from '../config/agent-env';
import { AgentProviderHandoff } from './providers/agent-provider';
import {
  AGENT_TOOLS,
  AgentToolDefinition,
  START_PLANNING_TOOL,
  TRIAGE_TOOLS,
} from './tools/agent-tools';

/**
 * Trasa tury: czym zaczyna, czym może skończyć.
 *
 * JEDNOSTKĄ DECYZJI JEST FAZA, nie tura i nie runda. Tura ma najwyżej dwie
 * fazy:
 *
 * - **CHAT** — tani model (`AI_MODEL_TOOLS`), narzędzia do CZYTANIA plus
 *   `start_planning`, wysiłek `AI_EFFORT_TOOLS` (domyślnie `low`, czyli na
 *   Haiku bez myślenia). Tu idzie rozmowa, pytania o plan i listę zakupów,
 *   pamięć domu, dopytanie.
 * - **PLANNER** — mocny model (`AI_MODEL`), pełna lista narzędzi, wysiłek
 *   `AI_EFFORT`. Tu idzie wszystko, co UKŁADA albo ZMIENIA plan.
 *
 * Przejście następuje dokładnie raz, w jedną stronę, i wyzwala je JEDYNIE
 * wywołanie narzędzia `start_planning` przez model fazy CHAT. Mechanizmem
 * jest więc narzędzie, nie klasyfikator: żadna cecha tekstu, historii ani
 * gospodarstwa nie bierze udziału w decyzji, więc nie ma czego zgadywać ani
 * czego kalibrować. „Do jakiego mechanizmu jaki model" mówi jedna tabela —
 * `AGENT_TOOL_TIERS` w `tools/agent-tools.ts`: narzędzia warstwy `planner`
 * po prostu NIE ISTNIEJĄ na liście modelu fazy CHAT, więc tani model nie ma
 * fizycznej możliwości ułożyć planu ani zapisać przepisu.
 *
 * Bez `AI_MODEL_TOOLS` trasa ma jedną fazę na `AI_MODEL` — dokładnie
 * dzisiejsze zachowanie. To jest domyślne, więc sam ten plik niczego nie
 * zmienia, dopóki zmienna nie zostanie ustawiona.
 */
export type AgentRoute = {
  model: string;
  effort: AiEffort;
  tools: readonly AgentToolDefinition[];
  handoff: AgentProviderHandoff | null;
  /** Czy prompt ma nieść akapit o przekazaniu pałeczki. */
  promptHandoff: boolean;
};

/** Czysta funkcja: ta sama konfiguracja zawsze daje tę samą trasę. */
export function resolveRoute(env: AgentEnv): AgentRoute {
  if (env.toolsModel === null) {
    return {
      model: env.model,
      effort: env.effort,
      tools: AGENT_TOOLS,
      handoff: null,
      promptHandoff: false,
    };
  }
  return {
    model: env.toolsModel,
    effort: env.effortTools,
    tools: TRIAGE_TOOLS,
    handoff: {
      tool: START_PLANNING_TOOL.name,
      model: env.model,
      effort: env.effort,
      tools: AGENT_TOOLS,
    },
    promptHandoff: true,
  };
}
