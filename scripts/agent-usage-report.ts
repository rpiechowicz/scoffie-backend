/**
 * Raport zużycia i kosztu asystenta z księgi `AiUsage` — do kalibracji
 * cennika i limitów na PRAWDZIWYM ruchu (cost-model.md: „price the tail,
 * not the median").
 *
 * Użycie (Railway → serwis Backend → Shell, albo lokalnie z DATABASE_URL):
 *   pnpm agent:report:usage            # bieżący miesiąc UTC
 *   pnpm agent:report:usage 2026-08    # wskazany miesiąc
 *   AGENT_REPORT_DAYS=30 pnpm agent:report:usage   # ostatnie N dni zamiast miesiąca
 *
 * Tylko odczyt. Nie wypisuje treści rozmów ani e-maili — identyfikatory
 * gospodarstw są skracane do 8 znaków.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)];
}

function usd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(4)}`;
}

async function main() {
  const arg = process.argv[2];
  const days = Number.parseInt(process.env.AGENT_REPORT_DAYS ?? '', 10);
  const now = new Date();
  let from: Date;
  let to: Date;
  let label: string;
  if (Number.isFinite(days) && days > 0) {
    from = new Date(now.getTime() - days * 86_400_000);
    to = now;
    label = `ostatnie ${days} dni`;
  } else {
    const [y, m] = (arg ?? now.toISOString().slice(0, 7))
      .split('-')
      .map(Number);
    from = new Date(Date.UTC(y, m - 1, 1));
    to = new Date(Date.UTC(y, m, 1));
    label = `${y}-${String(m).padStart(2, '0')} (UTC)`;
  }

  const rows = await prisma.aiUsage.findMany({
    where: { createdAt: { gte: from, lt: to } },
    select: {
      turnId: true,
      householdId: true,
      model: true,
      inputTokens: true,
      cacheReadTokens: true,
      cacheWriteTokens: true,
      outputTokens: true,
      costMicroUsd: true,
      apiCalls: true,
    },
  });

  console.log(
    `\nAsystent — zużycie za ${label}: ${rows.length} wierszy księgi (od 26.09.2026 jeden na wywołanie, wcześniej na fazę tury)`,
  );
  if (rows.length === 0) {
    console.log('Brak wpisów w księdze AiUsage w tym okresie.');
    return;
  }

  // per model
  const byModel = new Map<
    string,
    {
      calls: number;
      cost: number;
      inp: number;
      cr: number;
      cw: number;
      out: number;
    }
  >();
  for (const r of rows) {
    const m = byModel.get(r.model) ?? {
      calls: 0,
      cost: 0,
      inp: 0,
      cr: 0,
      cw: 0,
      out: 0,
    };
    m.calls += 1;
    m.cost += r.costMicroUsd;
    m.inp += r.inputTokens;
    m.cr += r.cacheReadTokens;
    m.cw += r.cacheWriteTokens;
    m.out += r.outputTokens;
    byModel.set(r.model, m);
  }
  console.log('\nPer model:');
  for (const [model, m] of byModel) {
    console.log(
      `  ${model.padEnd(20)} wywołań ${String(m.calls).padStart(6)}  koszt ${usd(m.cost).padStart(10)}  ` +
        `wejście ${m.inp}  cache-odczyt ${m.cr}  cache-zapis ${m.cw}  wyjście ${m.out}`,
    );
  }

  // per turn
  const byTurn = new Map<
    string,
    {
      cost: number;
      rows: number;
      /** Suma `apiCalls` faz; `null` = choć jedna faza tury jej nie zna. */
      apiCalls: number | null;
      householdId: string | null;
    }
  >();
  for (const r of rows) {
    const key = r.turnId ?? `bez-tury:${r.householdId ?? '-'}`;
    const t = byTurn.get(key) ?? {
      cost: 0,
      rows: 0,
      apiCalls: 0 as number | null,
      householdId: r.householdId,
    };
    t.cost += r.costMicroUsd;
    t.rows += 1;
    // Jedna faza bez pomiaru psuje sumę CAŁEJ tury — taka tura wypada
    // z rozkładu rund zamiast zaniżać go o brakującą fazę.
    t.apiCalls =
      t.apiCalls === null || r.apiCalls === null
        ? null
        : t.apiCalls + r.apiCalls;
    byTurn.set(key, t);
  }
  const turnCosts = [...byTurn.values()]
    .map((t) => t.cost)
    .sort((a, b) => a - b);
  const total = turnCosts.reduce((a, b) => a + b, 0);
  console.log(`\nTury: ${turnCosts.length}; koszt razem ${usd(total)}`);
  console.log(
    `  na turę: średnia ${usd(total / turnCosts.length)}  p50 ${usd(percentile(turnCosts, 50))}  ` +
      `p90 ${usd(percentile(turnCosts, 90))}  p95 ${usd(percentile(turnCosts, 95))}  max ${usd(turnCosts[turnCosts.length - 1])}`,
  );
  const modelsPerTurn = new Map<string, Set<string>>();
  for (const r of rows) {
    const key = r.turnId ?? `bez-tury:${r.householdId ?? '-'}`;
    const set = modelsPerTurn.get(key) ?? new Set<string>();
    set.add(r.model);
    modelsPerTurn.set(key, set);
  }
  const handedOff = [...modelsPerTurn.values()].filter(
    (set) => set.size > 1,
  ).length;
  console.log(
    `  tur z przekazaniem pałeczki (≥2 modele): ${handedOff} z ${modelsPerTurn.size}` +
      ` (${modelsPerTurn.size ? Math.round((100 * handedOff) / modelsPerTurn.size) : 0} %)`,
  );

  console.log(
    `  wierszy księgi na turę: średnia ${(rows.length / turnCosts.length).toFixed(2)}`,
  );

  // RUNDY MODELU, nie wiersze księgi. Do 7.09.2026 ta linia liczyła wiersze
  // i nazywała je „wywołaniami na turę" — a wiersz to FAZA, więc tura po
  // dwunastu rundach raportowała się jako jedno wywołanie. Teraz liczba
  // pochodzi z `AiUsage.apiCalls`; tury sprzed tej kolumny (`null`) są
  // POMIJANE, a nie liczone jako zero.
  const roundsPerTurn = [...byTurn.values()]
    .map((t) => t.apiCalls)
    .filter((calls): calls is number => calls !== null)
    .sort((a, b) => a - b);
  if (roundsPerTurn.length === 0) {
    console.log(
      '  rund modelu na turę: brak danych (wiersze sprzed kolumny apiCalls)',
    );
  } else {
    const sum = roundsPerTurn.reduce((a, b) => a + b, 0);
    console.log(
      `  rund modelu na turę (${roundsPerTurn.length} z ${byTurn.size} tur): ` +
        `średnia ${(sum / roundsPerTurn.length).toFixed(2)}  ` +
        `p50 ${percentile(roundsPerTurn, 50)}  p95 ${percentile(roundsPerTurn, 95)}  ` +
        `p99 ${percentile(roundsPerTurn, 99)}  max ${roundsPerTurn[roundsPerTurn.length - 1]}`,
    );
  }

  // per household
  const byHousehold = new Map<string, { cost: number; turns: number }>();
  for (const t of byTurn.values()) {
    const key = t.householdId ?? '-';
    const h = byHousehold.get(key) ?? { cost: 0, turns: 0 };
    h.cost += t.cost;
    h.turns += 1;
    byHousehold.set(key, h);
  }
  const households = [...byHousehold.entries()].sort(
    (a, b) => b[1].cost - a[1].cost,
  );
  console.log(
    `\nGospodarstwa: ${households.length}; koszt na gospodarstwo: średnia ${usd(total / households.length)}`,
  );
  console.log('  top 10 (id skrócone):');
  for (const [id, h] of households.slice(0, 10)) {
    console.log(
      `    ${id.slice(0, 8).padEnd(8)}  tur ${String(h.turns).padStart(4)}  koszt ${usd(h.cost).padStart(10)}  na turę ${usd(h.cost / h.turns)}`,
    );
  }
  console.log(
    '\nJak czytać: p95 na turę to koszt „ciężkiej" wiadomości — limit miesięczny × p95 to realistyczny ' +
      'najgorszy miesiąc jednego domu; koszt na gospodarstwo vs przychód netto z subskrypcji daje marżę.',
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
