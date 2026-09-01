/**
 * Jedno PRAWDZIWE wywołanie asystenta — dymny test providera Anthropic.
 *
 * Wszystko inne w tym repo sprawdza asystenta na dostawcy `stub`, czyli bez
 * modelu. To jest jedyne miejsce, które odpowiada na pytanie „czy protokół,
 * narzędzia i prompt naprawdę się składają" — i dlatego jest osobnym
 * skryptem, a nie testem: kosztuje pieniądze i nie ma prawa chodzić w CI.
 *
 * Zakłada tymczasowego użytkownika i gospodarstwo, odpala turę i sprząta po
 * sobie. Na koniec drukuje zużycie i koszt w mikrodolarach, żeby było widać,
 * ile naprawdę kosztuje jedna tura.
 *
 * Uruchomienie (wymaga ANTHROPIC_API_KEY):
 *   pnpm agent:smoke
 *   pnpm agent:smoke -- --prompt "Zaplanuj mi poniedziałkową kolację"
 *   pnpm agent:smoke -- --model claude-haiku-4-5
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AgentPromptService } from '../src/agent/agent-prompt.service';
import { AgentToolExecutor } from '../src/agent/tools/agent-tool-executor';
import { AGENT_TOOLS } from '../src/agent/tools/agent-tools';
import { AnthropicAgentProvider } from '../src/agent/providers/anthropic-agent.provider';
import { readAgentEnv } from '../src/config/agent-env';

const DEFAULT_PROMPT =
  'Zaproponuj jedną kolację na poniedziałek dla tego domu. Krótko uzasadnij wybór. Nie zapisuj planu.';

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

async function main(): Promise<void> {
  if (!(process.env.ANTHROPIC_API_KEY ?? '').trim()) {
    console.error('Brak ANTHROPIC_API_KEY — ten skrypt woła prawdziwe API.');
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const prisma = app.get(PrismaService);
  const prompts = app.get(AgentPromptService);
  const tools = app.get(AgentToolExecutor);
  const provider = app.get(AnthropicAgentProvider);

  const env = readAgentEnv();
  const model = flag('model') ?? env.model;
  const question = flag('prompt') ?? DEFAULT_PROMPT;
  const stamp = `${Date.now()}`;

  const user = await prisma.user.create({
    data: {
      displayName: `Smoke ${stamp}`,
      email: `smoke-${stamp}@agent.local`,
      authProvider: 'DEV',
      heightCm: 180,
      weightKg: 80,
      yearOfBirth: 1996,
      sex: 'MALE',
    },
    select: { id: true },
  });
  const household = await prisma.household.create({
    data: { name: `Dom smoke ${stamp}`, createdById: user.id },
    select: { id: true },
  });
  await prisma.membership.create({
    data: { userId: user.id, householdId: household.id, role: 'OWNER' },
  });

  try {
    const today = new Date().toISOString().slice(0, 10);
    const prompt = await prompts.build(user.id, household.id, {
      weekStart: '2026-08-31',
      clientToday: today,
      timeZone: 'Europe/Warsaw',
    });

    console.log(`model: ${model}, effort: ${env.effort}`);
    console.log(`pytanie: ${question}\n`);

    const started = Date.now();
    const result = await provider.run({
      model,
      effort: env.effort,
      system: prompt.system,
      messages: [{ role: 'USER', text: question }],
      tools: AGENT_TOOLS,
      executeTool: (name, input) => {
        console.log(`  → narzędzie: ${name}`);
        return tools.execute(name, input, {
          userId: user.id,
          householdId: household.id,
          catalogIndex: prompt.catalogIndex,
          // Kontekst tury — od propozycji planu narzędzia muszą wiedzieć,
          // do której rozmowy i tury przypiąć wynik.
          conversationId: '00000000-0000-4000-8000-00000000c0a1',
          turnId: '00000000-0000-4000-8000-00000000c0a2',
        });
      },
      signal: AbortSignal.timeout(env.turnTimeoutMs),
    });

    console.log(`\n--- odpowiedź (${Date.now() - started} ms) ---`);
    console.log(result.text);
    console.log('\n--- zużycie ---');
    console.log(`wywołań API: ${result.apiCalls}`);
    console.log(
      `wejście ${result.usage.inputTokens}, cache odczyt ${result.usage.cacheReadTokens}, ` +
        `cache zapis ${result.usage.cacheWriteTokens}, wyjście ${result.usage.outputTokens}`,
    );
    console.log(
      `koszt: ${result.usage.costMicroUsd} µUSD = $${(result.usage.costMicroUsd / 1_000_000).toFixed(4)}`,
    );
  } finally {
    // Sprzątamy zawsze — także po nieudanej turze; inaczej każde uruchomienie
    // zostawia w bazie dev osierocone gospodarstwo.
    await prisma.household.deleteMany({ where: { id: household.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error('Smoke asystenta nie powiódł się:', error);
  process.exit(1);
});
