import {
  COOK_INGREDIENT_PARTS,
  COOK_LIMITS,
  COOK_NOTE_KINDS,
  COOK_SCENARIO_SCHEMA_VERSION,
  COOK_STEP_PHASES,
  COOK_TIMER_TRIGGERS,
  type CookScenarioContent,
  type CookStep,
  type CookStepIngredient,
  type CookTimer,
} from './cook-scenario.types';

/**
 * Walidatory scenariusza trybu Gotuj — dwa poziomy:
 *
 * 1. `parseCookScenarioContent` — KSZTAŁT: typy, słowniki, limity długości
 *    (JSON z bazy albo z modelu jest `unknown`; w projekcie nie ma zoda, więc
 *    strażnik jest ręczny, jak `parseTurnExecution`). Zwraca wszystkie błędy
 *    naraz — raport trafia do panelu, a model dostaje go przy ponowieniu.
 * 2. `checkScenarioAgainstRecipe` — ZGODNOŚĆ z przepisem (§7.3): składniki
 *    tylko z przepisu, każdy użyty, suma ilości = ilość w przepisie, porcje,
 *    timery. Reszta walidatorów z §7.3 (układ pracy, bezpieczeństwo, liczby
 *    w tekście) dochodzi z systemem pisania (Etap E3).
 */

export interface ParseResult {
  content: CookScenarioContent | null;
  errors: string[];
}

type Rec = Record<string, unknown>;

const isRecord = (value: unknown): value is Rec =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isOneOf = <T extends string>(
  list: readonly T[],
  value: unknown,
): value is T => typeof value === 'string' && list.includes(value as T);

class Collector {
  readonly errors: string[] = [];

  text(value: unknown, path: string, max: number): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      this.errors.push(`${path}: wymagany niepusty tekst`);
      return '';
    }
    if (value.length > max) {
      this.errors.push(`${path}: ${value.length} znaków, limit ${max}`);
    }
    return value;
  }

  optionalText(value: unknown, path: string, max: number): string | null {
    if (value === null || value === undefined) return null;
    return this.text(value, path, max);
  }

  positive(value: unknown, path: string, max = Number.MAX_SAFE_INTEGER) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      this.errors.push(`${path}: wymagana liczba dodatnia`);
      return 0;
    }
    if (value > max) this.errors.push(`${path}: ${value} ponad limit ${max}`);
    return value;
  }

  positiveInt(value: unknown, path: string, max = Number.MAX_SAFE_INTEGER) {
    const n = this.positive(value, path, max);
    if (n && !Number.isInteger(n)) {
      this.errors.push(`${path}: wymagana liczba całkowita`);
    }
    return n;
  }
}

function parseIngredient(
  c: Collector,
  value: unknown,
  path: string,
): CookStepIngredient | null {
  if (!isRecord(value)) {
    c.errors.push(`${path}: wymagany obiekt`);
    return null;
  }
  if (!isOneOf(COOK_INGREDIENT_PARTS, value.part)) {
    c.errors.push(
      `${path}.part: dozwolone ${COOK_INGREDIENT_PARTS.join(', ')}`,
    );
  }
  return {
    ingredientId: c.text(value.ingredientId, `${path}.ingredientId`, 64),
    amount: c.positive(value.amount, `${path}.amount`),
    unit: c.text(value.unit, `${path}.unit`, 16),
    part: isOneOf(COOK_INGREDIENT_PARTS, value.part) ? value.part : 'ALL',
  };
}

function parseTimer(
  c: Collector,
  value: unknown,
  path: string,
): CookTimer | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    c.errors.push(`${path}: wymagany obiekt albo null`);
    return null;
  }
  const minSeconds = c.positiveInt(
    value.minSeconds,
    `${path}.minSeconds`,
    COOK_LIMITS.timerSecondsMax,
  );
  const maxSeconds = c.positiveInt(
    value.maxSeconds,
    `${path}.maxSeconds`,
    COOK_LIMITS.timerSecondsMax,
  );
  if (minSeconds && maxSeconds && maxSeconds < minSeconds) {
    c.errors.push(`${path}: maxSeconds mniejsze niż minSeconds`);
  }
  if (!isOneOf(COOK_TIMER_TRIGGERS, value.trigger)) {
    c.errors.push(
      `${path}.trigger: dozwolone ${COOK_TIMER_TRIGGERS.join(', ')}`,
    );
  }
  const alert = isRecord(value.alert) ? value.alert : {};
  if (!isRecord(value.alert)) c.errors.push(`${path}.alert: wymagany obiekt`);
  return {
    id: c.text(value.id, `${path}.id`, 32),
    label: c.text(value.label, `${path}.label`, COOK_LIMITS.timerLabel),
    minSeconds,
    maxSeconds,
    trigger: isOneOf(COOK_TIMER_TRIGGERS, value.trigger)
      ? value.trigger
      : 'NOW',
    startLabel: c.text(
      value.startLabel,
      `${path}.startLabel`,
      COOK_LIMITS.timerStartLabel,
    ),
    alert: {
      title: c.text(
        alert.title,
        `${path}.alert.title`,
        COOK_LIMITS.timerAlertTitle,
      ),
      body: c.text(
        alert.body,
        `${path}.alert.body`,
        COOK_LIMITS.timerAlertBody,
      ),
    },
  };
}

function parseStep(
  c: Collector,
  value: unknown,
  path: string,
): CookStep | null {
  if (!isRecord(value)) {
    c.errors.push(`${path}: wymagany obiekt`);
    return null;
  }
  if (!isOneOf(COOK_STEP_PHASES, value.phase)) {
    c.errors.push(`${path}.phase: dozwolone ${COOK_STEP_PHASES.join(', ')}`);
  }
  const ingredients = Array.isArray(value.ingredients) ? value.ingredients : [];
  if (!Array.isArray(value.ingredients)) {
    c.errors.push(`${path}.ingredients: wymagana lista`);
  }
  const mentions = Array.isArray(value.mentions) ? value.mentions : [];
  if (!Array.isArray(value.mentions)) {
    c.errors.push(`${path}.mentions: wymagana lista`);
  }
  let note: CookStep['note'] = null;
  if (value.note !== null && value.note !== undefined) {
    if (!isRecord(value.note) || !isOneOf(COOK_NOTE_KINDS, value.note.kind)) {
      c.errors.push(
        `${path}.note: { kind: ${COOK_NOTE_KINDS.join('|')}, text }`,
      );
    } else {
      note = {
        kind: value.note.kind,
        text: c.text(value.note.text, `${path}.note.text`, COOK_LIMITS.note),
      };
    }
  }
  let scaleNote: CookStep['scaleNote'] = null;
  if (value.scaleNote !== null && value.scaleNote !== undefined) {
    if (!isRecord(value.scaleNote)) {
      c.errors.push(`${path}.scaleNote: wymagany obiekt albo null`);
    } else {
      scaleNote = {
        fromPortions: c.positiveInt(
          value.scaleNote.fromPortions,
          `${path}.scaleNote.fromPortions`,
          99,
        ),
        text: c.text(
          value.scaleNote.text,
          `${path}.scaleNote.text`,
          COOK_LIMITS.scaleNote,
        ),
      };
    }
  }
  return {
    id: c.text(value.id, `${path}.id`, 16),
    phase: isOneOf(COOK_STEP_PHASES, value.phase) ? value.phase : 'COOK',
    stage: c.optionalText(value.stage, `${path}.stage`, COOK_LIMITS.stage),
    title: c.text(value.title, `${path}.title`, COOK_LIMITS.title),
    body: c.text(value.body, `${path}.body`, COOK_LIMITS.body),
    ingredients: ingredients
      .map((item, i) => parseIngredient(c, item, `${path}.ingredients[${i}]`))
      .filter((item): item is CookStepIngredient => item !== null),
    mentions: mentions.map((item, i) =>
      c.text(item, `${path}.mentions[${i}]`, 64),
    ),
    note,
    timer: parseTimer(c, value.timer, `${path}.timer`),
    during: c.optionalText(value.during, `${path}.during`, 32),
    scaleNote,
  };
}

/** Kształt scenariusza z `unknown` (baza, plik, model). */
export function parseCookScenarioContent(value: unknown): ParseResult {
  const c = new Collector();
  if (!isRecord(value)) {
    return { content: null, errors: ['scenariusz: wymagany obiekt'] };
  }
  if (value.schemaVersion !== COOK_SCENARIO_SCHEMA_VERSION) {
    c.errors.push(`schemaVersion: oczekiwano ${COOK_SCENARIO_SCHEMA_VERSION}`);
  }
  const basePortions = c.positiveInt(value.basePortions, 'basePortions', 99);
  const totalMinutes = c.positiveInt(
    value.totalMinutes,
    'totalMinutes',
    24 * 60,
  );

  let portionUnit: CookScenarioContent['portionUnit'] = null;
  if (value.portionUnit !== null && value.portionUnit !== undefined) {
    const unit = value.portionUnit;
    if (
      !isRecord(unit) ||
      !Array.isArray(unit.forms) ||
      unit.forms.length !== 3 ||
      !unit.forms.every((form) => typeof form === 'string' && form.length > 0)
    ) {
      c.errors.push('portionUnit: { id, forms: [1, 2–4, 5+] }');
    } else {
      portionUnit = {
        id: c.text(unit.id, 'portionUnit.id', 32),
        forms: unit.forms as [string, string, string],
      };
    }
  }

  const tips = Array.isArray(value.tips) ? value.tips : [];
  if (!Array.isArray(value.tips)) c.errors.push('tips: wymagana lista');
  if (tips.length > COOK_LIMITS.tipsMax) {
    c.errors.push(`tips: ${tips.length} rad, limit ${COOK_LIMITS.tipsMax}`);
  }

  const steps = Array.isArray(value.steps) ? value.steps : [];
  if (!Array.isArray(value.steps)) c.errors.push('steps: wymagana lista');
  if (
    steps.length < COOK_LIMITS.stepsMin ||
    steps.length > COOK_LIMITS.stepsMax
  ) {
    c.errors.push(
      `steps: ${steps.length} kroków, dozwolone ${COOK_LIMITS.stepsMin}–${COOK_LIMITS.stepsMax}`,
    );
  }

  const content: CookScenarioContent = {
    schemaVersion: COOK_SCENARIO_SCHEMA_VERSION,
    basePortions,
    portionUnit,
    totalMinutes,
    tips: tips.map((tip, i) => c.text(tip, `tips[${i}]`, COOK_LIMITS.tip)),
    nextTimeTip: c.optionalText(
      value.nextTimeTip,
      'nextTimeTip',
      COOK_LIMITS.nextTimeTip,
    ),
    steps: steps
      .map((step, i) => parseStep(c, step, `steps[${i}]`))
      .filter((step): step is CookStep => step !== null),
  };
  return { content: c.errors.length ? null : content, errors: c.errors };
}

/** Składnik przepisu, do którego odnosi się scenariusz. */
export interface ScenarioRecipeIngredient {
  ingredientId: string;
  name: string;
  amount: number;
  unit: string;
}

export interface ScenarioRecipe {
  servings: number;
  ingredients: ScenarioRecipeIngredient[];
}

/** Ile wolno się rozjechać sumie części (zaokrąglenia przy dzieleniu). */
const sumTolerance = (amount: number) => Math.max(0.01, amount * 0.01);

/**
 * Zgodność z przepisem. Pusta lista = zgodny. Kolejność błędów stabilna
 * (kroki po kolei, potem składniki przepisu), żeby raport dało się porównać.
 */
export function checkScenarioAgainstRecipe(
  content: CookScenarioContent,
  recipe: ScenarioRecipe,
): string[] {
  const errors: string[] = [];
  const byId = new Map(
    recipe.ingredients.map((row) => [row.ingredientId, row]),
  );
  const used = new Map<string, number>();

  if (content.basePortions !== recipe.servings) {
    errors.push(
      `basePortions ${content.basePortions} ≠ porcje przepisu ${recipe.servings}`,
    );
  }

  const stepIds = new Set<string>();
  const timerIds = new Set<string>();
  content.steps.forEach((step, index) => {
    const path = `steps[${index}]`;
    if (stepIds.has(step.id))
      errors.push(`${path}.id: powtórzone „${step.id}”`);
    stepIds.add(step.id);

    // `during` wskazuje timer, który już biegnie — z wcześniejszego kroku.
    if (step.during && !timerIds.has(step.during)) {
      errors.push(
        `${path}.during: brak wcześniejszego timera „${step.during}”`,
      );
    }
    if (step.timer) {
      if (timerIds.has(step.timer.id)) {
        errors.push(`${path}.timer.id: powtórzone „${step.timer.id}”`);
      }
      timerIds.add(step.timer.id);
    }

    step.ingredients.forEach((item, i) => {
      const source = byId.get(item.ingredientId);
      if (!source) {
        errors.push(`${path}.ingredients[${i}]: składnika nie ma w przepisie`);
        return;
      }
      if (item.unit !== source.unit) {
        errors.push(
          `${path}.ingredients[${i}] (${source.name}): jednostka ${item.unit} ≠ ${source.unit}`,
        );
        return;
      }
      used.set(
        item.ingredientId,
        (used.get(item.ingredientId) ?? 0) + item.amount,
      );
    });
    step.mentions.forEach((id, i) => {
      if (!byId.has(id))
        errors.push(`${path}.mentions[${i}]: składnika nie ma w przepisie`);
    });
  });

  for (const source of recipe.ingredients) {
    const sum = used.get(source.ingredientId);
    if (sum === undefined) {
      errors.push(`składnik „${source.name}” nie trafia do żadnego kroku`);
    } else if (Math.abs(sum - source.amount) > sumTolerance(source.amount)) {
      errors.push(
        `składnik „${source.name}”: w krokach ${round(sum)} ${source.unit}, w przepisie ${source.amount} ${source.unit}`,
      );
    }
  }
  return errors;
}

const round = (value: number) => Math.round(value * 100) / 100;
