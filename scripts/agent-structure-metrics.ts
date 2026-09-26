/**
 * Strukturalne metryki asystenta BEZ modelu (Etap 6.1): ile narzędzi widzi
 * model, ile ważą ich schematy i instrukcje, ile pól nieobowiązkowych —
 * czyli to, co przekłada się na prefiks promptu i koszt każdego wywołania.
 *
 *   pnpm exec ts-node --transpile-only -r tsconfig-paths/register scripts/agent-structure-metrics.ts [--out plik.json]
 *
 * Zero wywołań API. Tokeny = ESTIMATE (znaki / 3,6 — średnia z pomiaru
 * `cacheReadTokens` w Etapie 6: 25 441 tokenów na ~92 tys. znaków prefiksu).
 */
import { writeFileSync } from 'fs';
import { readAgentEnv } from '../src/config/agent-env';
import { resolveRoute } from '../src/agent/agent-route';
import { AGENT_TOOLS } from '../src/agent/tools/agent-tools';
import { AGENT_INSTRUCTIONS } from '../src/agent/agent-system-prompt';

const CHARS_PER_TOKEN = 3.6;

function optionalFields(tools: readonly { input_schema: unknown }[]): number {
  let count = 0;
  for (const tool of tools) {
    const schema = tool.input_schema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    const props = Object.keys(schema.properties ?? {});
    const required = new Set(schema.required ?? []);
    count += props.filter((name) => !required.has(name)).length;
  }
  return count;
}

const route = resolveRoute(readAgentEnv({ AI_ENABLED: 'true' }));
const toolsJson = JSON.stringify(route.tools);
const instructions = Array.isArray(AGENT_INSTRUCTIONS)
  ? (AGENT_INSTRUCTIONS as string[]).join('\n')
  : String(AGENT_INSTRUCTIONS);
const out = {
  modelTools: route.tools.length,
  modelToolNames: route.tools.map((tool) => tool.name),
  toolSchemaChars: toolsJson.length,
  toolSchemaTokensEstimate: Math.round(toolsJson.length / CHARS_PER_TOKEN),
  instructionsChars: instructions.length,
  optionalFieldsAllTools: optionalFields(AGENT_TOOLS),
  perTool: Object.fromEntries(
    route.tools.map((tool) => [tool.name, JSON.stringify(tool).length]),
  ),
};
const file = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : null;
if (file) writeFileSync(file, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ...out, perTool: undefined }, null, 2));
