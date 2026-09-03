import { AgentEnv, AI_EFFORT_TOOLS_DEFAULT } from '../config/agent-env';
import { resolveRoute } from './agent-route';
import {
  AGENT_TOOLS,
  AGENT_TOOL_TIERS,
  PLANNING_TOOL_NAMES,
  START_PLANNING_TOOL,
} from './tools/agent-tools';

const env = (over: Partial<AgentEnv> = {}): AgentEnv =>
  ({
    enabled: true,
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    toolsModel: null,
    effort: 'medium',
    effortTools: AI_EFFORT_TOOLS_DEFAULT,
    ...over,
  }) as AgentEnv;

describe('resolveRoute', () => {
  it('bez AI_MODEL_TOOLS: jedna faza na AI_MODEL — dokładnie dzisiejsze zachowanie', () => {
    const route = resolveRoute(env());
    expect(route).toEqual({
      model: 'claude-sonnet-5',
      effort: 'medium',
      tools: AGENT_TOOLS,
      handoff: null,
      promptHandoff: false,
    });
  });

  it('z AI_MODEL_TOOLS: faza CHAT na tanim modelu z własnym wysiłkiem, planista w przekazaniu', () => {
    const route = resolveRoute(
      env({ toolsModel: 'claude-haiku-4-5', effortTools: 'low' }),
    );
    expect(route.model).toBe('claude-haiku-4-5');
    expect(route.effort).toBe('low');
    expect(route.promptHandoff).toBe(true);
    expect(route.handoff).toEqual({
      tool: START_PLANNING_TOOL.name,
      model: 'claude-sonnet-5',
      effort: 'medium',
      tools: AGENT_TOOLS,
    });
  });

  it('faza CHAT nie dostaje ANI JEDNEGO narzędzia, które układa albo zapisuje', () => {
    const route = resolveRoute(env({ toolsModel: 'claude-haiku-4-5' }));
    const names = route.tools.map((tool) => tool.name);
    for (const planner of PLANNING_TOOL_NAMES) {
      expect(names).not.toContain(planner);
    }
    expect(names).toContain(START_PLANNING_TOOL.name);
  });

  it('każde narzędzie ma przypisaną warstwę — nowe narzędzie bez decyzji nie przechodzi', () => {
    for (const tool of AGENT_TOOLS) {
      expect(AGENT_TOOL_TIERS[tool.name]).toMatch(/^(chat|planner)$/);
    }
    // I odwrotnie: tabela nie opisuje narzędzi, których już nie ma.
    const existing = new Set(AGENT_TOOLS.map((tool) => tool.name));
    for (const name of Object.keys(AGENT_TOOL_TIERS)) {
      expect(existing.has(name)).toBe(true);
    }
  });
});
