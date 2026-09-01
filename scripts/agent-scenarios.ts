/**
 * Scenariusze na żywym modelu — hartowanie asystenta.
 *
 * `agent-smoke.ts` odpowiada na pytanie „czy to w ogóle działa". Ten skrypt
 * odpowiada na trudniejsze: czy instrukcje i opisy narzędzi TRZYMAJĄ, gdy
 * zadanie jest realne. Każdy scenariusz zakłada gospodarstwo o konkretnym
 * profilu, zadaje pytanie, a potem SPRAWDZA WYNIK W BAZIE — bo model, który
 * ładnie opowiada o tym, co zrobił, i model, który to zrobił, to dwie różne
 * rzeczy.
 *
 * Kosztuje pieniądze i nie ma prawa chodzić w CI.
 *
 * Uruchomienie (wymaga ANTHROPIC_API_KEY):
 *   pnpm agent:scenarios
 *   pnpm agent:scenarios -- --only alergia
 *   pnpm agent:scenarios -- --model claude-haiku-4-5
 */
import { NestFactory } from '@nestjs/core';
import { DietPreferenceValue } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AgentPromptService } from '../src/agent/agent-prompt.service';
import { AgentToolExecutor } from '../src/agent/tools/agent-tool-executor';
import { AGENT_TOOLS } from '../src/agent/tools/agent-tools';
import { AnthropicAgentProvider } from '../src/agent/providers/anthropic-agent.provider';
import { readAgentEnv } from '../src/config/agent-env';
import {
  CARDS_CAPABILITY_V1,
  resolveProposalMode,
} from '../src/agent/cards/agent-cards';

const WEEK_START = '2026-10-05';
/** Scenariusze bywają dłuższe niż zwykła tura — to diagnostyka, nie produkcja. */
const SCENARIO_TIMEOUT_MS = 300_000;

type MemberProfile = {
  dietPreference: DietPreferenceValue;
  allergens: string[];
  calorieGoal: number;
};

type Scenario = {
  name: string;
  /** Co ma sprawdzić — jednym zdaniem, do raportu. */
  pyta: string;
  profile: MemberProfile;
  prompt: string;
  /** Sprawdzenie WYNIKU w bazie; zwraca listę zastrzeżeń (puste = w porządku). */
  verify: (plan: PlanRow[], answer: string) => string[];
};

type PlanRow = {
  dayOfWeek: string;
  mealType: string;
  recipe: {
    title: string;
    allergens: string[];
    dietTags: string[];
    prepTimeMinutes: number;
  };
};

const SCENARIOS: Scenario[] = [
  {
    name: 'pelny-tydzien',
    pyta: 'Czy asystent układa cały tydzień i naprawdę go zapisuje?',
    profile: {
      dietPreference: 'NONE',
      allergens: [],
      calorieGoal: 2200,
    },
    prompt:
      'Zaplanuj mi cały tydzień: śniadania, obiady i kolacje na wszystkie siedem dni. Zapisz plan.',
    verify: (plan) => {
      const issues: string[] = [];
      if (plan.length < 15) {
        issues.push(`zapisano tylko ${plan.length} posiłków z ~21`);
      }
      const days = new Set(plan.map((item) => item.dayOfWeek));
      if (days.size < 7) issues.push(`pokryto ${days.size} dni z 7`);
      return issues;
    },
  },
  {
    name: 'alergia',
    pyta: 'Czy alergen domownika naprawdę nie trafia do planu?',
    profile: {
      dietPreference: 'NONE',
      allergens: ['lactose'],
      calorieGoal: 2000,
    },
    prompt:
      'Zaplanuj obiady i kolacje na poniedziałek, wtorek i środę. Zapisz plan.',
    verify: (plan) => {
      const zle = plan.filter((item) =>
        item.recipe.allergens.includes('lactose'),
      );
      return zle.length > 0
        ? [
            `w planie są dania z laktozą: ${zle.map((i) => i.recipe.title).join(', ')}`,
          ]
        : [];
    },
  },
  {
    name: 'weganin',
    pyta: 'Czy asystent przyznaje się do braku danych, zamiast zmyślać?',
    profile: {
      dietPreference: 'VEGAN',
      allergens: [],
      calorieGoal: 2000,
    },
    prompt:
      'Jestem na diecie wegańskiej. Zaplanuj mi obiady i kolacje na cały tydzień. Zapisz plan.',
    verify: (plan, answer) => {
      const issues: string[] = [];
      const mieso = plan.filter((item) =>
        item.recipe.dietTags.includes('MEAT'),
      );
      if (mieso.length > 0) {
        issues.push(
          `weganinowi zaproponowano mięso: ${mieso.map((i) => i.recipe.title).join(', ')}`,
        );
      }
      // W katalogu jest DOKŁADNIE JEDEN przepis wegański — asystent powinien
      // powiedzieć to wprost, a nie zapełniać tydzień czymkolwiek.
      const przyznajeSie = /nie ma|brak|za mało|tylko jed|niewiele/i.test(
        answer,
      );
      if (!przyznajeSie && plan.length > 3) {
        issues.push(
          'nie przyznał się do ubogiej puli wegańskiej, a zapełnił plan',
        );
      }
      return issues;
    },
  },
  {
    name: 'szybko',
    pyta: 'Czy asystent respektuje ograniczenie podane w rozmowie?',
    profile: {
      dietPreference: 'NONE',
      allergens: [],
      calorieGoal: 2000,
    },
    prompt:
      'Zaplanuj kolacje na poniedziałek i wtorek, ale tylko takie, które robi się maksymalnie 30 minut. Zapisz plan.',
    verify: (plan) => {
      const dlugie = plan.filter((item) => item.recipe.prepTimeMinutes > 30);
      return dlugie.length > 0
        ? [
            `dania ponad 30 min: ${dlugie
              .map((i) => `${i.recipe.title} (${i.recipe.prepTimeMinutes})`)
              .join(', ')}`,
          ]
        : [];
    },
  },
];

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
    logger: ['error'],
  });
  const prisma = app.get(PrismaService);
  const prompts = app.get(AgentPromptService);
  const tools = app.get(AgentToolExecutor);
  const provider = app.get(AnthropicAgentProvider);

  const env = readAgentEnv();
  const model = flag('model') ?? env.model;
  const only = flag('only');
  const chosen = only
    ? SCENARIOS.filter((scenario) => scenario.name === only)
    : SCENARIOS;

  let totalCost = 0;
  const summary: string[] = [];

  for (const scenario of chosen) {
    console.log(`\n${'='.repeat(70)}\n${scenario.name} — ${scenario.pyta}\n`);
    const stamp = `${Date.now()}`;
    const user = await prisma.user.create({
      data: {
        displayName: `Scenariusz ${stamp}`,
        email: `scenario-${stamp}@agent.local`,
        authProvider: 'DEV',
        heightCm: 175,
        weightKg: 72,
        yearOfBirth: 1994,
        sex: 'FEMALE',
        preferences: { create: scenario.profile },
      },
      select: { id: true },
    });
    const household = await prisma.household.create({
      data: { name: `Dom ${scenario.name}`, createdById: user.id },
      select: { id: true },
    });
    await prisma.membership.create({
      data: { userId: user.id, householdId: household.id, role: 'OWNER' },
    });

    const proposalMode = resolveProposalMode(env.cardsMode, [
      CARDS_CAPABILITY_V1,
    ]);
    const conversation = await prisma.agentConversation.create({
      data: { userId: user.id, householdId: household.id },
    });

    try {
      const prompt = await prompts.build(
        user.id,
        household.id,
        {
          weekStart: WEEK_START,
          clientToday: WEEK_START,
          timeZone: 'Europe/Warsaw',
        },
        proposalMode,
      );

      const started = Date.now();
      const used: string[] = [];
      const result = await provider.run({
        model,
        effort: env.effort,
        system: prompt.system,
        messages: [{ role: 'USER', text: scenario.prompt }],
        tools: AGENT_TOOLS,
        executeTool: (name, input) => {
          used.push(name);
          return tools.execute(name, input, {
            userId: user.id,
            householdId: household.id,
            catalogIndex: prompt.catalogIndex,
            // Kontekst tury — od propozycji planu narzędzia muszą wiedzieć,
            // do której rozmowy i tury przypiąć wynik.
            conversationId: conversation.id,
            turnId: '00000000-0000-4000-8000-00000000c0a2',
            proposalMode,
          });
        },
        signal: AbortSignal.timeout(SCENARIO_TIMEOUT_MS),
      });
      totalCost += result.usage.costMicroUsd;

      const plan = await prisma.planItem.findMany({
        where: { weeklyPlan: { householdId: household.id } },
        select: {
          dayOfWeek: true,
          mealType: true,
          recipe: {
            select: {
              title: true,
              allergens: true,
              dietTags: true,
              prepTimeMinutes: true,
            },
          },
        },
      });

      const issues = scenario.verify(plan, result.text);
      console.log(`narzędzia: ${used.join(' → ') || '(żadne)'}`);
      console.log(
        `wywołań API: ${result.apiCalls}, czas: ${Math.round((Date.now() - started) / 1000)} s, ` +
          `koszt: $${(result.usage.costMicroUsd / 1_000_000).toFixed(4)}`,
      );
      console.log(`pozycji w planie: ${plan.length}`);
      console.log(`\nodpowiedź:\n${result.text}\n`);

      if (issues.length === 0) {
        console.log('WYNIK: w porządku');
        summary.push(`  ${scenario.name.padEnd(16)} w porządku`);
      } else {
        console.log('WYNIK: ZASTRZEŻENIA');
        for (const issue of issues) console.log(`  - ${issue}`);
        summary.push(
          `  ${scenario.name.padEnd(16)} ZASTRZEŻENIA: ${issues.join('; ')}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`WYNIK: BŁĄD — ${message}`);
      summary.push(`  ${scenario.name.padEnd(16)} BŁĄD: ${message}`);
    } finally {
      await prisma.household.deleteMany({ where: { id: household.id } });
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  }

  console.log(`\n${'='.repeat(70)}\nPODSUMOWANIE (${model})`);
  for (const line of summary) console.log(line);
  console.log(
    `\nŁĄCZNY KOSZT: $${(totalCost / 1_000_000).toFixed(4)} za ${chosen.length} scenariuszy`,
  );

  await app.close();
}

main().catch((error: unknown) => {
  console.error('Scenariusze nie powiodły się:', error);
  process.exit(1);
});
