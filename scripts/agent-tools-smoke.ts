/**
 * Sprawdzian schematów narzędzi na PRAWDZIWYM API — jedyny, który je łapie.
 *
 * Anthropic waliduje schematy PRZED wywołaniem modelu i odmawia całej
 * odpowiedzi na dwa sposoby, których nie widać z naszej strony:
 *   - „too many optional parameters (limit: 24)",
 *   - „compiled grammar is too large" — przy `strict: true` schematy są
 *     kompilowane do gramatyki i liczy się jej ŁĄCZNY rozmiar.
 * Dostawca `stub`, na którym stoi całe e2e, schematów nie ogląda, więc suita
 * bywa zielona, a tura pada dopiero u użytkownika.
 *
 * Skrypt wysyła najkrótsze możliwe żądanie (`max_tokens: 1`) wyłącznie po to,
 * żeby API wypowiedziało się o schematach. Koszt jest w groszach.
 *
 *   pnpm exec tsx scripts/agent-tools-smoke.ts
 */
import Anthropic from '@anthropic-ai/sdk';
import { AGENT_TOOLS } from '../src/agent/tools/agent-tools';
import { AI_MODEL_DEFAULT } from '../src/config/agent-env';

async function main(): Promise<void> {
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? '').trim();
  if (!apiKey) {
    console.error('Brak ANTHROPIC_API_KEY — ten skrypt woła prawdziwe API.');
    process.exit(1);
  }

  const strict = AGENT_TOOLS.filter((tool) => tool.strict).length;
  console.log(
    `narzędzi: ${AGENT_TOOLS.length}, w tym ze strict: ${strict}, model: ${
      process.env.AI_MODEL ?? AI_MODEL_DEFAULT
    }`,
  );

  const client = new Anthropic({ apiKey });
  try {
    await client.messages.create({
      model: process.env.AI_MODEL ?? AI_MODEL_DEFAULT,
      max_tokens: 1,
      tools: AGENT_TOOLS as never,
      messages: [{ role: 'user', content: 'ping' }],
    });
    console.log('OK — API przyjęło schematy narzędzi.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ODMOWA API:\n${message}`);
    process.exit(1);
  }
}

void main();
