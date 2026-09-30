import {
  COOK_SCENARIO_SCHEMA_VERSION,
  type CookScenarioContent,
} from '../cook-scenario.types';
import {
  checkScenarioAgainstRecipe,
  parseCookScenarioContent,
} from '../cook-scenario.validate';
import { ingredientKey } from './writer.prompt';
import type { WriterRecipe } from './writer.types';

/**
 * Walidatory twarde systemu pisania (§7.3) — deterministyczne, w kodzie.
 * `errors` blokują (autor dostaje je w raporcie i pisze od nowa),
 * `warnings` idą do recenzenta i raportu, ale same nie odrzucają.
 */
export interface CheckResult {
  errors: string[];
  warnings: string[];
}

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface ResolvedOutput {
  decision: 'WRITE' | 'SKIP' | null;
  skipReason: string | null;
  content: CookScenarioContent | null;
  errors: string[];
}

/**
 * Odpowiedź modelu → treść scenariusza: klucze → id składników, porcje
 * i jednostki z przepisu, potem walidator kształtu i zgodności z przepisem.
 */
export function resolveWriterOutput(
  recipe: WriterRecipe,
  output: unknown,
): ResolvedOutput {
  const fail = (error: string): ResolvedOutput => ({
    decision: null,
    skipReason: null,
    content: null,
    errors: [error],
  });
  if (!isRecord(output)) return fail('odpowiedź: oczekiwano obiektu JSON');
  if (output.decision === 'SKIP') {
    const reason =
      typeof output.skipReason === 'string' ? output.skipReason.trim() : '';
    return {
      decision: 'SKIP',
      skipReason: reason || null,
      content: null,
      errors: reason ? [] : ['SKIP bez powodu (skipReason)'],
    };
  }
  if (output.decision !== 'WRITE') return fail('decision: WRITE albo SKIP');
  const scenario = output.scenario;
  if (!isRecord(scenario) || !Array.isArray(scenario.steps)) {
    return fail('scenario: wymagany przy decision = WRITE');
  }

  const errors: string[] = [];
  // Miejsca z kluczem spoza przepisu — parser dopisałby tam jeszcze „pusty
  // ingredientId/unit”; autor ma dostać jeden punkt, nie trzy.
  const unresolved: string[] = [];
  const byKey = new Map(
    recipe.ingredients.map((row, index) => [ingredientKey(index), row]),
  );
  const steps = (scenario.steps as unknown[]).map((step, index) => {
    if (!isRecord(step)) return step;
    const path = `steps[${index}]`;
    const ingredients = Array.isArray(step.ingredients)
      ? (step.ingredients as unknown[]).map((item, i) => {
          if (!isRecord(item)) return item;
          const source =
            typeof item.key === 'string' ? byKey.get(item.key) : undefined;
          if (!source) {
            unresolved.push(`${path}.ingredients[${i}]`);
            errors.push(
              `${path}.ingredients[${i}]: klucza „${String(item.key)}” nie ma w przepisie`,
            );
          }
          return {
            ingredientId: source?.ingredientId ?? '',
            amount: item.amount,
            unit: source?.unit ?? '',
            part: item.part,
          };
        })
      : step.ingredients;
    const mentions = Array.isArray(step.mentions)
      ? (step.mentions as unknown[]).map((key, i) => {
          const source = typeof key === 'string' ? byKey.get(key) : undefined;
          if (!source) {
            unresolved.push(`${path}.mentions[${i}]`);
            errors.push(
              `${path}.mentions[${i}]: klucza „${String(key)}” nie ma w przepisie`,
            );
          }
          return source?.ingredientId ?? '';
        })
      : step.mentions;
    return { ...step, ingredients, mentions };
  });

  const parsed = parseCookScenarioContent({
    schemaVersion: COOK_SCENARIO_SCHEMA_VERSION,
    basePortions: recipe.servings,
    portionUnit: scenario.portionUnit,
    totalMinutes: scenario.totalMinutes,
    tips: scenario.tips,
    nextTimeTip: scenario.nextTimeTip,
    steps,
  });
  errors.push(
    ...parsed.errors.filter(
      (error) =>
        !unresolved.some(
          (place) =>
            error.startsWith(`${place}.`) || error.startsWith(`${place}:`),
        ),
    ),
  );
  if (!parsed.content || errors.length) {
    return { decision: 'WRITE', skipReason: null, content: null, errors };
  }
  const consistency = checkScenarioAgainstRecipe(parsed.content, {
    servings: recipe.servings,
    ingredients: recipe.ingredients,
  });
  return {
    decision: 'WRITE',
    skipReason: null,
    content: consistency.length ? null : parsed.content,
    errors: consistency,
  };
}

// ── Czasy z przepisu ────────────────────────────────────────────────────

const PL = 'a-ząćęłńóśźż';
const NUM = String.raw`(\d+(?:[.,]\d+)?)`;
const TIME_UNIT = `(min[${PL}.]*|godz[${PL}.]*|h(?![${PL}])|sek[${PL}.]*)`;
const DURATION = new RegExp(
  `${NUM}(?:\\s*(?:[–—-]|do)\\s*${NUM})?\\s*${TIME_UNIT}`,
  'gi',
);

const unitSeconds = (unit: string) => {
  const u = unit.toLowerCase();
  if (u.startsWith('godz') || u === 'h') return 3600;
  if (u.startsWith('sek')) return 1;
  return 60;
};
const toNumber = (raw: string) => Number(raw.replace(',', '.'));

/** Zakresy czasów [min, max] w sekundach wymienione w krokach przepisu. */
export function recipeDurations(instructions: string[]): [number, number][] {
  const found: [number, number][] = [];
  for (const line of instructions) {
    for (const match of line.matchAll(DURATION)) {
      const seconds = unitSeconds(match[3]);
      const from = toNumber(match[1]) * seconds;
      const to = match[2] ? toNumber(match[2]) * seconds : from;
      found.push([Math.min(from, to), Math.max(from, to)]);
    }
    const lower = line.toLowerCase();
    if (lower.includes('kwadrans')) found.push([900, 900]);
    if (lower.includes('pół godziny')) found.push([1800, 1800]);
    if (lower.includes('półtorej godziny')) found.push([5400, 5400]);
    if (/(^|[^\d\s]\s*)godzinę/.test(lower)) found.push([3600, 3600]);
  }
  return found;
}

const tolerance = (seconds: number) => Math.max(60, seconds * 0.1);

// ── Cyfry i tokeny w tekście ────────────────────────────────────────────

const COUNT_TOKEN = /\{count:[a-z][a-z-]*\|[^|{}]+\|[^|{}]+\|[^|{}]+\}/g;
const NUMBER_IN_TEXT = new RegExp(
  `\\d+(?:[.,]\\d+)?(?:\\s*(?:[–—-]|do)\\s*\\d+(?:[.,]\\d+)?)?`,
  'g',
);
const ALLOWED_AFTER_NUMBER = new RegExp(
  `^\\s*(?:min|godz|h(?![${PL}])|sek|s(?![${PL}])|°|stopni|cm|mm|%)`,
  'i',
);

function textFields(content: CookScenarioContent): [string, string][] {
  const fields: [string, string][] = [];
  content.tips.forEach((tip, i) => fields.push([`tips[${i}]`, tip]));
  if (content.nextTimeTip) fields.push(['nextTimeTip', content.nextTimeTip]);
  content.steps.forEach((step) => {
    const p = step.id;
    fields.push([`${p}.title`, step.title], [`${p}.body`, step.body]);
    if (step.stage) fields.push([`${p}.stage`, step.stage]);
    if (step.note) fields.push([`${p}.note`, step.note.text]);
    if (step.scaleNote) fields.push([`${p}.scaleNote`, step.scaleNote.text]);
    if (step.timer) {
      fields.push(
        [`${p}.timer.label`, step.timer.label],
        [`${p}.timer.startLabel`, step.timer.startLabel],
        [`${p}.timer.alert.title`, step.timer.alert.title],
        [`${p}.timer.alert.body`, step.timer.alert.body],
      );
    }
  });
  return fields;
}

function checkNumbersInText(
  recipe: WriterRecipe,
  content: CookScenarioContent,
  errors: string[],
) {
  // Nazwy składników z cyframi („śmietana 12”) nie są ilościami.
  const namesWithDigits = recipe.ingredients
    .map((row) => row.name.toLowerCase())
    .filter((name) => /\d/.test(name))
    .sort((a, b) => b.length - a.length);
  for (const [path, raw] of textFields(content)) {
    let value = raw.replace(COUNT_TOKEN, ' ');
    if (/[{}]/.test(value)) {
      errors.push(
        `${path}: zły token — dozwolony tylko {count:id|forma1|forma2-4|forma5+}`,
      );
    }
    for (const name of namesWithDigits) {
      value = value.split(name).join(' ');
      value = value
        .split(name.charAt(0).toUpperCase() + name.slice(1))
        .join(' ');
    }
    for (const match of value.matchAll(NUMBER_IN_TEXT)) {
      const after = value.slice((match.index ?? 0) + match[0].length);
      if (!ALLOWED_AFTER_NUMBER.test(after)) {
        errors.push(
          `${path}: liczba „${match[0]}” w tekście — ilości tylko przy kroku, sztuki tokenem {count:…}; cyfry wolno tylko dla czasu, temperatury i rozmiaru`,
        );
      }
    }
  }
}

// ── Piekarnik ───────────────────────────────────────────────────────────

const OVEN_USE = /(do piekarnika|w piekarniku|z piekarnika)(?!\s*mikrofal)/i;
const OVEN_PREHEAT = new RegExp(
  `(nagrzej|rozgrzej|nagrzewaj)[${PL}]*\\s[^.]*piekarnik`,
  'i',
);

const stepText = (step: CookScenarioContent['steps'][number]) =>
  [step.title, step.body, step.note?.text ?? ''].join(' ');

function checkOven(content: CookScenarioContent, errors: string[]) {
  const texts = content.steps.map(stepText);
  const firstUse = texts.findIndex((line) => OVEN_USE.test(line));
  if (firstUse < 0) return;
  const preheat = texts.findIndex((line) => OVEN_PREHEAT.test(line));
  if (preheat < 0 || preheat >= firstUse) {
    errors.push(
      `${content.steps[firstUse].id}: piekarnik używany bez wcześniejszego kroku „Nagrzej piekarnik do …°C”`,
    );
  }
}

// ── Bezpieczeństwo (§5.5) ───────────────────────────────────────────────

const PROCESSED =
  /(bulion|rosół|rosoł|wywar|kostk|wędzon|szynk|parówk|kiełbas|puszk|konserw|w sosie|sos |marynowan|solon|pasta|w oleju|pasztet)/i;
const POULTRY = /(kurczak|kurczę|indyk|indycz|kacz|drobi|gęś|gęsi)/i;
const MINCED = /mielon/i;
const FISH =
  /(łoso|dorsz|mintaj|pstrąg|makrel|halibut|morszczuk|tilapi|panga|okoń|sandacz|karp|tuńczyk|ryb|krewet)/i;

/**
 * Sygnały „gotowe” muszą być TWIERDZĄCE (review Codexa, E3a runda 1): samo
 * słowo „różowy” pasowało też do „mięso może zostać różowe” i „różowy sos”.
 * Dlatego całe frazy („bez różowego”, „sok przezroczysty”, temperatura),
 * a przed dopasowaniem nie może stać przeczenie ani „może”.
 */
const NO_PINK = String.raw`bez\s+(?:śladu\s+|odrobiny\s+)?różow|nie\s+(?:jest|są|ma|będzie|będą)\s+(?:już\s+)?różow|nic\s+różow`;
const SAFETY: {
  label: string;
  ingredient: RegExp;
  cue: RegExp;
  hint: string;
}[] = [
  {
    label: 'drób',
    ingredient: POULTRY,
    cue: new RegExp(
      String.raw`7[4-9]\s*°C|przezroczyst[\p{L}]*\s+sok|sok\s+(?:jest\s+|będzie\s+|wypływa\s+|wypłynie\s+|ma\s+być\s+)?przezroczyst|${NO_PINK}`,
      'giu',
    ),
    hint: '74°C w środku albo „sok przezroczysty, bez różowego w środku”',
  },
  {
    label: 'mięso mielone',
    ingredient: MINCED,
    cue: new RegExp(String.raw`7[1-9]\s*°C|${NO_PINK}`, 'giu'),
    hint: '71°C w środku albo „bez różowego w środku”',
  },
  {
    label: 'ryba',
    ingredient: FISH,
    cue: /6[3-9]\s*°C|matow|nieprzezroczyst|łatwo\s+(?:się\s+)?(?:rozdziela|rozpada|oddziela)|rozpada\s+się\s+na\s+płatki/giu,
    hint: 'mięso matowe, nieprzezroczyste, łatwo się rozdziela',
  },
];

/** Przeczenie albo „może” tuż przed dopasowaniem („może zostać różowe”). */
const NEGATED_BEFORE =
  /(?:^|[\s,;(—-])(?:nie|może|mogą|chyba|czasem|jeszcze)(?:\s+[^\s.,;:!?]+){0,2}\s*$/iu;

function hasAffirmativeCue(text: string, cue: RegExp): boolean {
  for (const match of text.matchAll(cue)) {
    const found = match[0].toLowerCase();
    const before = text.slice(
      Math.max(0, (match.index ?? 0) - 30),
      match.index,
    );
    if (found.startsWith('nie') || found.startsWith('nic')) return true;
    if (!NEGATED_BEFORE.test(before)) return true;
  }
  return false;
}

function checkSafety(
  recipe: WriterRecipe,
  content: CookScenarioContent,
  errors: string[],
) {
  for (const rule of SAFETY) {
    for (const raw of recipe.ingredients) {
      if (!rule.ingredient.test(raw.name) || PROCESSED.test(raw.name)) continue;
      // Sygnał liczy się dopiero od kroku, w którym surowiec wchodzi do pracy
      // — „bez różowego” w rozgrzewce nie mówi nic o gotowym mięsie.
      const enters = content.steps.findIndex(
        (step) =>
          step.ingredients.some(
            (item) => item.ingredientId === raw.ingredientId,
          ) || step.mentions.includes(raw.ingredientId),
      );
      const from = enters < 0 ? 0 : enters;
      const cued = content.steps
        .slice(from)
        .some((step) => hasAffirmativeCue(stepText(step), rule.cue));
      if (!cued) {
        errors.push(
          `bezpieczeństwo (${rule.label}: „${raw.name}”): brak „po czym poznać” — ${rule.hint}`,
        );
      }
    }
  }
}

// ── Całość ──────────────────────────────────────────────────────────────

/** Walidatory jakości treści, która już przeszła kształt i sumy. */
export function qualityChecks(
  recipe: WriterRecipe,
  content: CookScenarioContent,
): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  checkNumbersInText(recipe, content, errors);
  checkOven(content, errors);
  checkSafety(recipe, content, errors);

  // Timery tylko z czasami z przepisu (§5.3: czasów nie zmieniamy).
  const durations = recipeDurations(recipe.instructions);
  const timers = content.steps.flatMap((step) =>
    step.timer ? [{ step: step.id, timer: step.timer }] : [],
  );
  for (const { step, timer } of timers) {
    const fits = durations.some(
      ([from, to]) =>
        timer.minSeconds >= from - tolerance(from) &&
        timer.maxSeconds <= to + tolerance(to),
    );
    if (!fits) {
      errors.push(
        `${step}.timer „${timer.label}” ${timer.minSeconds}–${timer.maxSeconds} s: takiego czasu nie ma w przepisie (przepis: ${
          durations
            .map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`))
            .join(', ') || 'brak czasów'
        } s)`,
      );
    }
  }
  for (const [from, to] of durations) {
    if (to < 180) continue;
    const covered = timers.some(
      ({ timer }) =>
        timer.maxSeconds >= from - tolerance(from) &&
        timer.minSeconds <= to + tolerance(to),
    );
    if (!covered) {
      warnings.push(
        `czas z przepisu ${from === to ? from : `${from}–${to}`} s nie ma timera`,
      );
    }
  }

  if (recipe.prepTimeMinutes > 0) {
    const ratio = content.totalMinutes / recipe.prepTimeMinutes;
    if (ratio < 0.7 || ratio > 1.3) {
      warnings.push(
        `totalMinutes ${content.totalMinutes} a czas przepisu ${recipe.prepTimeMinutes} min (poza ±30%)`,
      );
    }
  }
  return { errors, warnings };
}

/**
 * D29: pominąć wolno tylko przepis naprawdę trywialny. Deterministyczna
 * bramka — model nie może „oszczędzić sobie pracy” na przepisie z czasem.
 */
export function skipGuard(recipe: WriterRecipe): string | null {
  if (recipeDurations(recipe.instructions).length) {
    return 'SKIP niedozwolony: przepis ma czasy (gotowanie, pieczenie, chłodzenie) — napisz scenariusz';
  }
  if (recipe.instructions.length > 4 || recipe.prepTimeMinutes > 15) {
    return `SKIP niedozwolony: przepis ma ${recipe.instructions.length} kroków i ${recipe.prepTimeMinutes} min — napisz scenariusz`;
  }
  return null;
}
