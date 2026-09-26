#!/usr/bin/env node
/**
 * Etap 6 — podsumowanie surowych wyników benchmarku (bez zależności).
 *
 *   node benchmark/final-model-eval/summarize.js [--sets before,after,candidates/B,...] [--tag r1]
 *
 * Każdy „zestaw" = katalog z plikami `<scenariusz>.<tag>.json` z harnessu.
 * Koszt liczony z tokenów tym samym cennikiem dla każdego commita
 * (`src/config/model-prices.ts`, identyczny na anchorze i HEAD) — i dla
 * kontroli porównywany z kosztem zapisanym przez dostawcę.
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PRICE = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

/** Kategorie z polecenia Etapu 6 (A–F) i koszyki rozkładu kosztu. */
const CATEGORY = (name) => {
  if (/^g2-|^g13-mam-kurczaka|^g13-pokaz-inne/.test(name)) return 'suggestion';
  if (/^g3-|^g11-/.test(name)) return 'editing';
  if (/^g13-wybieram-druga|^g13-zmiana-w-propozycji|^g12-dluga-rozmowa/.test(name))
    return 'follow-up';
  if (/^g4-|^g5-|^g6-|^g7-|^g8-|^g9-/.test(name)) return 'planning';
  return 'chat/discovery';
};
const LETTER = (name) => {
  if (/^g2-|^g13-mam-kurczaka/.test(name)) return 'A chat/discovery';
  if (/^g4-|^g5-|^g6-|^g8-rozne-cele|^g8-podzial/.test(name)) return 'B planowanie';
  if (/^g3-|^g11-|^g13-pokaz-inne|^g8-zakres/.test(name)) return 'C edycja';
  if (/^g7-|^g9-/.test(name)) return 'D ograniczenia';
  if (/^g13-wybieram|^g13-zmiana|^g12-dluga|^g12-trwala|^g12-chwilowa/.test(name))
    return 'E state/follow-up';
  return 'F proste pytania';
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

function load(set, tagFilter) {
  const dir = path.join(ROOT, set);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    if (tagFilter && !tagFilter.split(',').some((tag) => file.endsWith(`.${tag}.json`))) continue;
    const json = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    for (const record of json.records ?? []) {
      out.push({ ...record, commit: json.commit, file, set });
    }
  }
  return out;
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const avg = (xs) => (xs.length ? sum(xs) / xs.length : 0);
function pct(xs, p) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1))];
}

function tokenCost(r) {
  const price = PRICE[r.model] ?? PRICE['claude-opus-5'];
  // Harness sumuje całą turę pod modelem konfiguracji (bez podziału faz) —
  // w konfiguracjach A/B/D/E to jeden model, więc przeliczenie jest dokładne.
  return (
    r.inputTokens * price.input +
    r.cacheReadTokens * price.input * 0.1 +
    r.cacheWriteTokens * price.input * 2 +
    r.outputTokens * price.output
  );
}

/** Odchylenie kcal dnia na osobę dla DNI PEŁNYCH (wszystkie włączone pory). */
function kcalDeviation(r) {
  const enabled = r.enabledMealTypes ?? ['BREAKFAST', 'LUNCH', 'DINNER'];
  const out = [];
  if (!r.target?.length || !r.members?.length) return out;
  const days = [...new Set(r.target.map((row) => row.dayOfWeek))];
  for (const member of r.members) {
    for (const day of days) {
      const slots = r.target.filter(
        (row) =>
          row.dayOfWeek === day &&
          (row.participantIds.length === 0 || row.participantIds.includes(member.userId)),
      );
      const meals = new Set(slots.map((row) => row.mealType));
      if (!enabled.every((meal) => meals.has(meal))) continue;
      const kcal = sum(
        slots.map((row) => {
          const eaters = row.participantIds.length || r.members.length;
          return (row.kcalPerServing * (row.plannedServings || eaters)) / eaters;
        }),
      );
      out.push(((kcal - member.calorieGoal) / member.calorieGoal) * 100);
    }
  }
  return out;
}

function metrics(records) {
  const n = records.length;
  const passes = records.filter((r) => r.pass);
  const cost = records.map((r) => r.costMicroUsd / 1e6);
  const turns = records.flatMap((r) => r.turnApiCalls ?? []);
  const lat = records.map((r) => r.latencyMs / 1000);
  const callLat = records.flatMap((r) => (r.timings ?? []).map((t) => t.totalMs / 1000));
  const totalCost = sum(cost);
  return {
    runs: n,
    passRate: n ? passes.length / n : 0,
    successes: passes.length,
    totalCostUsd: totalCost,
    tokenCostCheckUsd: sum(records.map(tokenCost)) / 1e6,
    avgCostUsd: avg(cost),
    costPerSuccessUsd: passes.length ? totalCost / passes.length : null,
    medianCostUsd: pct(cost, 50),
    p50LatencyS: pct(lat, 50),
    p95LatencyS: pct(lat, 95),
    p50CallLatencyS: pct(callLat, 50),
    p95CallLatencyS: pct(callLat, 95),
    avgApiCalls: avg(records.map((r) => r.apiCalls)),
    avgRoundsPerTurn: avg(turns),
    avgToolCalls: avg(records.map((r) => r.tools.length)),
    avgInputTokens: avg(records.map((r) => r.inputTokens)),
    avgOutputTokens: avg(records.map((r) => r.outputTokens)),
    avgCacheRead: avg(records.map((r) => r.cacheReadTokens)),
    avgCacheWrite: avg(records.map((r) => r.cacheWriteTokens)),
    errors: records.filter((r) => r.error).length,
  };
}

function routing(records) {
  const share = (rs, pred) => (rs.length ? rs.filter(pred).length / rs.length : null);
  const sugg = records.filter((r) => CATEGORY(r.scenario) === 'suggestion' && !/pokaz-inne/.test(r.scenario));
  const plan = records.filter((r) => /^g4-|^g5-|^g6-|^g8-rozne/.test(r.scenario));
  const edit = records.filter((r) => /^g3-/.test(r.scenario));
  const cardTurns = records.flatMap((r) => r.stopReasons ?? []);
  return {
    suggestion: {
      runs: sugg.length,
      suggestMealsShare: share(sugg, (r) => r.tools.includes('suggest_meals')),
      findRecipesShare: share(sugg, (r) => r.tools.includes('find_recipes')),
      avgApiCalls: avg(sugg.map((r) => r.apiCalls)),
    },
    planning: {
      runs: plan.length,
      buildMealPlanShare: share(plan, (r) => r.tools.includes('build_meal_plan')),
      manualProposeShare: share(plan, (r) =>
        r.tools.some((t) => ['propose_week_plan', 'propose_day_plan', 'apply_week_plan'].includes(t)),
      ),
      startPlanningShare: share(plan, (r) => r.tools.includes('start_planning')),
      avgApiCalls: avg(plan.map((r) => r.apiCalls)),
      plannerStatus: plan
        .flatMap((r) => (r.toolCalls ?? []).map((c) => c.plannerStatus).filter(Boolean))
        .reduce((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {}),
    },
    editing: {
      runs: edit.length,
      replacePlanItemShare: share(edit, (r) => r.tools.includes('replace_plan_item')),
      proposeSwapShare: share(edit, (r) => r.tools.includes('propose_swap')),
    },
    terminalCards: {
      turns: cardTurns.length,
      toolEndedTurnShare: cardTurns.length
        ? cardTurns.filter((s) => s === 'tool_ended_turn').length / cardTurns.length
        : null,
    },
  };
}

function plannerQuality(records) {
  const plan = records.filter((r) => /^g4-|^g5-|^g6-|^g8-rozne|^g7-/.test(r.scenario));
  const devs = plan.flatMap(kcalDeviation).map(Math.abs);
  return {
    fullDays: devs.length,
    meanAbsDayKcalDevPct: devs.length ? avg(devs) : null,
    p95AbsDayKcalDevPct: devs.length ? pct(devs, 95) : null,
    maxAbsDayKcalDevPct: devs.length ? Math.max(...devs) : null,
    within10Pct: devs.length ? devs.filter((d) => d <= 10).length / devs.length : null,
  };
}

function groupBy(records, key) {
  const out = {};
  for (const r of records) (out[key(r.scenario)] ??= []).push(r);
  return out;
}

const sets = (arg('sets', 'before,after') ?? '').split(',').filter(Boolean);
const tag = arg('tag', null);
const summary = { generatedAt: new Date().toISOString(), tag, sets: {} };
for (const set of sets) {
  const records = load(set, tag);
  if (!records.length) continue;
  summary.sets[set] = {
    commit: [...new Set(records.map((r) => r.commit))],
    config: [...new Set(records.map((r) => `${r.config} ${r.model}/${r.effort}`))],
    overall: metrics(records),
    byCategory: Object.fromEntries(
      Object.entries(groupBy(records, CATEGORY)).map(([k, rs]) => [k, metrics(rs)]),
    ),
    byLetter: Object.fromEntries(
      Object.entries(groupBy(records, LETTER)).map(([k, rs]) => [k, metrics(rs)]),
    ),
    routing: routing(records),
    plannerQuality: plannerQuality(records),
    perScenario: Object.fromEntries(
      Object.entries(groupBy(records, (s) => s)).map(([k, rs]) => [
        k,
        {
          runs: rs.length,
          pass: rs.filter((r) => r.pass).length,
          avgCostUsd: avg(rs.map((r) => r.costMicroUsd / 1e6)),
          avgLatencyS: avg(rs.map((r) => r.latencyMs / 1000)),
          avgApiCalls: avg(rs.map((r) => r.apiCalls)),
          tools: [...new Set(rs.flatMap((r) => r.tools))],
          issues: [...new Set(rs.flatMap((r) => r.issues))].slice(0, 6),
        },
      ]),
    ),
  };
}
const outFile = arg('out', null);
if (outFile) fs.writeFileSync(path.resolve(outFile), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
