import {
  COOK_INGREDIENT_PARTS,
  COOK_NOTE_KINDS,
  COOK_STEP_PHASES,
  COOK_TIMER_TRIGGERS,
} from '../cook-scenario.types';

/**
 * JSON Schema odpowiedzi modeli (Structured Outputs).
 *
 * Schemat jest STAŁY dla wszystkich przepisów — zmiana `output_config.format`
 * unieważnia cache promptu, więc klucze składników (`i1`…) są zwykłymi
 * napisami, a ich zgodność z przepisem sprawdza walidator. Structured
 * Outputs nie wymuszają długości ani zakresów liczb — to też robią walidatory.
 *
 * Czego model NIE pisze, bo wynika z przepisu: `schemaVersion`,
 * `basePortions` (= porcje przepisu) i `unit` przy składniku (= jednostka
 * przepisu). Mniej pól do pomylenia.
 */

const nullable = (schema: Record<string, unknown>) => ({
  anyOf: [schema, { type: 'null' }],
});

const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const text = { type: 'string' };
const integer = { type: 'integer' };

const timer = object({
  id: text,
  label: text,
  minSeconds: integer,
  maxSeconds: integer,
  trigger: { type: 'string', enum: [...COOK_TIMER_TRIGGERS] },
  startLabel: text,
  alert: object({ title: text, body: text }),
});

const step = object({
  id: text,
  phase: { type: 'string', enum: [...COOK_STEP_PHASES] },
  stage: nullable(text),
  title: text,
  body: text,
  ingredients: {
    type: 'array',
    items: object({
      key: text,
      amount: { type: 'number' },
      part: { type: 'string', enum: [...COOK_INGREDIENT_PARTS] },
    }),
  },
  mentions: { type: 'array', items: text },
  note: nullable(
    object({ kind: { type: 'string', enum: [...COOK_NOTE_KINDS] }, text }),
  ),
  timer: nullable(timer),
  during: nullable(text),
  scaleNote: nullable(object({ fromPortions: integer, text })),
});

export const WRITER_OUTPUT_SCHEMA: Record<string, unknown> = object({
  decision: { type: 'string', enum: ['WRITE', 'SKIP'] },
  skipReason: nullable(text),
  scenario: nullable(
    object({
      portionUnit: nullable(
        object({ id: text, forms: { type: 'array', items: text } }),
      ),
      totalMinutes: integer,
      tips: { type: 'array', items: text },
      nextTimeTip: nullable(text),
      steps: { type: 'array', items: step },
    }),
  ),
});

export const REVIEW_SEVERITIES = ['BLOCKER', 'MAJOR', 'MINOR'] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

export const REVIEWER_OUTPUT_SCHEMA: Record<string, unknown> = object({
  score: { type: 'integer', enum: [1, 2, 3, 4, 5] },
  issues: {
    type: 'array',
    items: object({
      stepId: nullable(text),
      severity: { type: 'string', enum: [...REVIEW_SEVERITIES] },
      text,
    }),
  },
  summary: text,
});
