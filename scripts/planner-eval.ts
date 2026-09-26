/**
 * Bezpłatna ocena serwerowego planera na LOKALNYM katalogu — bez modelu
 * (workstream assistant-backend-optimization, Etap 2).
 *
 * Dla kilku typowych domów (osoba sama, para o różnych celach, wege bez
 * glutenu, rodzina z alergią) układa tydzień i dzień, podmienia jeden slot
 * i wypisuje metryki planera (`evaluatePlan`): odchylenia kcal i makro,
 * złamane ograniczenia twarde (zawsze 0), powtórki, niespełnione preferencje,
 * funkcję celu, kandydatów, czas i liczbę zapytań DB. Te same metryki liczy
 * `AgentMealPlannerService.evaluate` dla DOWOLNEGO planu — np. ułożonego
 * przez model w benchmarku Etapu 6 — więc „lepszy plan" da się porównać
 * liczbami, a nie czytaniem odpowiedzi.
 *
 * Zakłada tymczasowych użytkowników i domy, kasuje je na końcu. NIE uruchamiać
 * na produkcji.
 *
 *   pnpm exec ts-node -r tsconfig-paths/register scripts/planner-eval.ts
 *   … --runs 3 --out benchmark/planner-eval.json
 */
import { Test } from '@nestjs/testing';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { DayOfWeek, DietPreferenceValue, Sex } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  AgentMealPlannerService,
  PlannerOutcome,
  PlannerWishes,
} from '../src/agent/planner/agent-meal-planner.service';
import { PlanMetrics } from '../src/meal-planner/meal-planner.types';

const WEEK_START = '2026-09-28';
const WEEK: DayOfWeek[] = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

type QueryEvent = { query: string; duration: number };

class CountingPrisma extends PrismaService {
  queries = 0;
  constructor() {
    super({ log: [{ emit: 'event', level: 'query' }] });
    (
      this as unknown as {
        $on(event: 'query', cb: (e: QueryEvent) => void): void;
      }
    ).$on('query', () => {
      this.queries += 1;
    });
  }
}

type Person = {
  name: string;
  sex: Sex;
  heightCm: number;
  weightKg: number;
  yearOfBirth: number;
  calorieGoal: number;
  allergens?: string[];
  diet?: DietPreferenceValue;
};

const SCENARIOS: { name: string; people: Person[] }[] = [
  {
    name: 'solo-2000',
    people: [
      {
        name: 'Ola',
        sex: 'FEMALE',
        heightCm: 168,
        weightKg: 62,
        yearOfBirth: 1994,
        calorieGoal: 2000,
      },
    ],
  },
  {
    name: 'para-1600-2600',
    people: [
      {
        name: 'Ania',
        sex: 'FEMALE',
        heightCm: 162,
        weightKg: 58,
        yearOfBirth: 1996,
        calorieGoal: 1600,
      },
      {
        name: 'Marek',
        sex: 'MALE',
        heightCm: 184,
        weightKg: 88,
        yearOfBirth: 1992,
        calorieGoal: 2600,
      },
    ],
  },
  {
    name: 'wege-bez-glutenu',
    people: [
      {
        name: 'Ewa',
        sex: 'FEMALE',
        heightCm: 170,
        weightKg: 65,
        yearOfBirth: 1990,
        calorieGoal: 1900,
        allergens: ['gluten'],
        diet: 'VEGETARIAN',
      },
    ],
  },
  {
    name: 'rodzina-4-orzechy',
    people: [
      {
        name: 'Kasia',
        sex: 'FEMALE',
        heightCm: 165,
        weightKg: 60,
        yearOfBirth: 1988,
        calorieGoal: 1800,
      },
      {
        name: 'Tomek',
        sex: 'MALE',
        heightCm: 180,
        weightKg: 82,
        yearOfBirth: 1987,
        calorieGoal: 2500,
      },
      {
        name: 'Zosia',
        sex: 'FEMALE',
        heightCm: 140,
        weightKg: 34,
        yearOfBirth: 2015,
        calorieGoal: 1500,
        allergens: ['nuts'],
      },
      {
        name: 'Staś',
        sex: 'MALE',
        heightCm: 150,
        weightKg: 42,
        yearOfBirth: 2013,
        calorieGoal: 1900,
      },
    ],
  },
];

const NO_WISHES: PlannerWishes = {
  diet: null,
  requiredTags: [],
  preferredTags: [],
  avoidIngredients: [],
  maxPrepMinutes: null,
};

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

type Row = {
  scenario: string;
  operation: string;
  run: number;
  status: string;
  queries: number;
  wallMs: number;
  metrics: PlanMetrics;
};

async function main(): Promise<void> {
  const runs = Math.max(1, Number(flag('runs') ?? '3'));
  process.env.AI_ENABLED = 'true';
  process.env.AI_PROVIDER = 'stub';
  process.env.AI_CONSENT_REQUIRED = 'false';
  const prisma = new CountingPrisma();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .compile();
  await moduleRef.init();
  const planner = moduleRef.get(AgentMealPlannerService);
  const createdUsers: string[] = [];
  const createdHouseholds: string[] = [];
  const rows: Row[] = [];

  try {
    for (const scenario of SCENARIOS) {
      const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
      const users: { id: string }[] = [];
      for (const person of scenario.people) {
        const user = await prisma.user.create({
          data: {
            displayName: person.name,
            email: `planner-eval-${stamp}-${person.name.toLowerCase()}@agent.local`,
            authProvider: 'DEV',
            sex: person.sex,
            heightCm: person.heightCm,
            weightKg: person.weightKg,
            yearOfBirth: person.yearOfBirth,
            preferences: {
              create: {
                calorieGoal: person.calorieGoal,
                allergens: person.allergens ?? [],
                dietPreference: person.diet ?? 'NONE',
              },
            },
          },
        });
        createdUsers.push(user.id);
        users.push(user);
      }
      const household = await prisma.household.create({
        data: { name: `Ocena ${scenario.name}`, createdById: users[0].id },
      });
      createdHouseholds.push(household.id);
      await prisma.membership.createMany({
        data: users.map((user, index) => ({
          userId: user.id,
          householdId: household.id,
          role: index === 0 ? ('OWNER' as const) : ('MEMBER' as const),
        })),
      });
      const base = {
        userId: users[0].id,
        householdId: household.id,
        weekStart: WEEK_START,
        mealTypes: [],
        forUserIds: [],
      };

      for (let run = 0; run < runs; run += 1) {
        const measure = async (
          operation: string,
          fn: () => Promise<PlannerOutcome>,
        ): Promise<PlannerOutcome> => {
          prisma.queries = 0;
          const started = Date.now();
          const outcome = await fn();
          rows.push({
            scenario: scenario.name,
            operation,
            run,
            status: outcome.draft.status,
            queries: prisma.queries,
            wallMs: Date.now() - started,
            metrics: outcome.draft.diagnostics.metrics,
          });
          return outcome;
        };
        const week = await measure('build-week', () =>
          planner.build({
            ...base,
            days: WEEK,
            wishes: NO_WISHES,
            seed: `run-${run}`,
          }),
        );
        await measure('build-day', () =>
          planner.build({
            ...base,
            days: ['WED'],
            wishes: NO_WISHES,
            seed: `run-${run}`,
          }),
        );
        await measure('replace-wed-dinner-wege-similar', () =>
          planner.replace({
            userId: users[0].id,
            householdId: household.id,
            weekStart: WEEK_START,
            dayOfWeek: 'WED',
            mealType: 'DINNER',
            currentSlots: week.targetSlots,
            wishes: { ...NO_WISHES, diet: 'VEGETARIAN' },
            similarKcal: true,
            portionMode: 'tune',
            seed: `run-${run}`,
          }),
        );
      }
    }
  } finally {
    await prisma.household.deleteMany({
      where: { id: { in: createdHouseholds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
    await moduleRef.close();
  }

  console.log(
    'scenariusz'.padEnd(20),
    'operacja'.padEnd(32),
    'status'.padEnd(8),
    'kcal% max% białko% złamań powt. miękkie kand. ms zapytań',
  );
  for (const row of rows.filter((entry) => entry.run === runs - 1)) {
    const m = row.metrics;
    console.log(
      row.scenario.padEnd(20),
      row.operation.padEnd(32),
      row.status.padEnd(8),
      [
        m.kcalDeviationPct,
        m.maxKcalDeviationPct,
        m.proteinDeviationPct ?? '-',
        m.hardViolations,
        m.repeats,
        m.softUnmet,
        m.candidatesConsidered,
        row.wallMs,
        row.queries,
      ].join('  '),
    );
  }
  const out = flag('out');
  if (out) {
    const path = resolve(out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ weekStart: WEEK_START, runs, rows }, null, 2),
    );
    console.log(`zapisano ${path}`);
  }
}

void main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
