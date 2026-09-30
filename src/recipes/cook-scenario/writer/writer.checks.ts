import {
  COOK_SCENARIO_SCHEMA_VERSION,
  type CookScenarioContent,
} from '../cook-scenario.types';
import {
  checkScenarioAgainstRecipe,
  parseCookScenarioContent,
} from '../cook-scenario.validate';
import { ingredientKey } from './writer.prompt';
import type { WriterIngredient, WriterRecipe } from './writer.types';

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
const PER_SIDE =
  /^\s*(?:[^\s.,;]+\s+){0,2}?z\s+(?:każdej|obu|jednej\s+i\s+drugiej)\s+stron/iu;

export function recipeDurations(instructions: string[]): [number, number][] {
  const found: [number, number][] = [];
  for (const line of instructions) {
    for (const match of line.matchAll(DURATION)) {
      const seconds = unitSeconds(match[3]);
      const from = toNumber(match[1]) * seconds;
      const to = match[2] ? toNumber(match[2]) * seconds : from;
      const range: [number, number] = [Math.min(from, to), Math.max(from, to)];
      found.push(range);
      // „Po 3 minuty z każdej strony” to DWA odliczania albo jedno łączne
      // (pilot E3b: ryba po grecku, gruszka) — oba zapisy są wierne przepisowi.
      const after = line
        .slice((match.index ?? 0) + match[0].length)
        .slice(0, 40);
      if (PER_SIDE.test(after)) {
        found.push(range, [range[0] * 2, range[1] * 2]);
      }
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

const QUANTITY_IN_RECIPE = new RegExp(
  `(\\d+(?:[.,]\\d+)?)\\s*([${PL}]+)`,
  'giu',
);
const UNIT_AFTER = new RegExp(`^\\s*([${PL}]+)`, 'iu');
const toAmount = (raw: string) => Number(raw.replace(',', '.'));
const sameUnit = (a: string, b: string) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
};

/**
 * Liczba z jednostką przepisana DOSŁOWNIE z kroków przepisu, która nie
 * jest ilością składnika z listy (pilot E3b, 30.09): „naczynie ok. 1,5 l”,
 * „100 ml zimnej wody”, gdy wody nie ma w składnikach — tego telefon nie
 * pokaże przy kroku, więc tekst musi to powiedzieć. Ilość składnika z listy
 * („320 g”) nadal wolno podać tylko przy kroku.
 */
function isRecipeQuantity(
  recipe: WriterRecipe,
  amount: number,
  unit: string,
): boolean {
  const inRecipe = recipe.instructions.some((line) =>
    [...line.matchAll(QUANTITY_IN_RECIPE)].some(
      (match) => toAmount(match[1]) === amount && sameUnit(match[2], unit),
    ),
  );
  const isIngredientAmount = recipe.ingredients.some(
    (row) => row.amount === amount && sameUnit(row.unit, unit),
  );
  return inRecipe && !isIngredientAmount;
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
      if (ALLOWED_AFTER_NUMBER.test(after)) continue;
      const unit = UNIT_AFTER.exec(after)?.[1];
      const single = /^\d+(?:[.,]\d+)?$/.test(match[0]);
      if (
        unit &&
        single &&
        isRecipeQuantity(recipe, toAmount(match[0]), unit)
      ) {
        continue;
      }
      errors.push(
        `${path}: liczba „${match[0]}” w tekście — ilości składników tylko przy kroku, sztuki tokenem {count:…}; cyframi wolno czas, temperaturę, rozmiar albo liczbę z jednostką przepisaną dosłownie z kroków przepisu (np. „1,5 l”, gdy nie jest ilością składnika)`,
      );
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

/**
 * Kogo dotyczy reguła „po czym poznać” (review Codexa, E3a rundy 3 i 5):
 * - zakres wg DZIAŁU katalogu — Mięso, Ryby, Mrożonki; „Konserwy” (tuńczyk
 *   w puszce) i „Przyprawy i sosy” (papryka mielona) z definicji nie; bez
 *   działu (przepis domu) decyduje nazwa;
 * - wyjątek tylko dla jednoznacznych produktów gotowych do jedzenia, pisanych
 *   od początku nazwy („wędlina…”, „szynka…”, „parówka…”) albo wędzonych
 *   i z puszki — i nigdy, gdy nazwa mówi „surowy” / „do gotowania”;
 *   „marynowany”, „w sosie”, „kiełbasa” wyjątkiem nie są.
 */
const RAW_DEPARTMENTS = new Set(['Mięso', 'Ryby', 'Mrożonki']);
const READY_PRODUCT =
  /^(?:wędlin|szynk|parówk|pasztet|bulion|rosół|wywar|kostk|sos |pasta )|wędzon|w puszce|z puszki|konserw|w oleju/iu;
const RAW_MARKER =
  /(surow|do gotowania|do pieczenia|do smażenia|do duszenia)/iu;

function needsDonenessCue(ingredient: WriterIngredient): boolean {
  if (ingredient.department && !RAW_DEPARTMENTS.has(ingredient.department)) {
    return false;
  }
  return (
    RAW_MARKER.test(ingredient.name) || !READY_PRODUCT.test(ingredient.name)
  );
}

const POULTRY = /(kurczak|kurczę|indyk|indycz|kacz|drobi|gęś|gęsi)/iu;
/** Mielone MIĘSO — „papryka mielona” i „imbir mielony” to przyprawy. */
const MINCED =
  /^(?=.*mielon)(?=.*(wieprz|wołow|mięs|indyk|kurcz|cielę|jagni|baran)).*/iu;
const FISH =
  /(łoso|dorsz|mintaj|pstrąg|makrel|halibut|morszczuk|tilapi|panga|okoń|sandacz|karp|tuńczyk|ryb|krewet|sardyn|śledź|szprot)/iu;

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
      if (!rule.ingredient.test(raw.name) || !needsDonenessCue(raw)) continue;
      // Sygnał musi stać w kroku, który ma TEN surowiec (w składnikach albo
      // przywołaniach) — „74°C” przy indyku nie mówi nic o kurczaku
      // smażonym osobno (review Codexa, E3a runda 5).
      const cued = content.steps.some(
        (step) =>
          (step.ingredients.some(
            (item) => item.ingredientId === raw.ingredientId,
          ) ||
            step.mentions.includes(raw.ingredientId)) &&
          hasAffirmativeCue(stepText(step), rule.cue),
      );
      if (!cued) {
        errors.push(
          `bezpieczeństwo (${rule.label}: „${raw.name}”): brak „po czym poznać” w kroku z tym składnikiem (w składnikach albo przywołaniach) — ${rule.hint}`,
        );
      }
    }
  }
}

// ── Czasy i temperatury w tekście (review Codexa, E3a runda 2) ───────────

/** Temperatury „po czym poznać” (§5.5) — wolno je pisać bez przepisu. */
const SAFETY_TEMPERATURES = new Set([63, 71, 74]);
const TEMPERATURE = /(\d{2,3})\s*(?:°\s*C|°|stopni)/giu;

/** Krótkie czynności („mieszaj 1 minutę”) nie zmieniają czasu dania. */
const SHORT_SECONDS = 120;

export function temperaturesIn(text: string): number[] {
  return [...text.matchAll(TEMPERATURE)].map((match) => Number(match[1]));
}

const describeRange = ([from, to]: [number, number]) =>
  from === to ? `${from} s` : `${from}–${to} s`;

const fitsRange = (value: [number, number], range: [number, number]) =>
  value[0] >= range[0] - tolerance(range[0]) &&
  value[1] <= range[1] + tolerance(range[1]);

/**
 * Każda temperatura z tekstu musi być w przepisie; każdy czas z tekstu —
 * w przepisie albo w granicach timera kroku (punkt kontrolny „po 3 minutach
 * obróć” w 10–12 min smażenia). Tekst nie może przeczyć timerowi kroku
 * („piecz 30 min” przy timerze 20 min).
 */
function checkTextClaims(
  recipe: WriterRecipe,
  content: CookScenarioContent,
  recipeRanges: [number, number][],
  errors: string[],
  warnings: string[],
) {
  const recipeText = [recipe.description ?? '', ...recipe.instructions].join(
    ' ',
  );
  const recipeTemperatures = new Set(temperaturesIn(recipeText));
  const timerMax = new Map(
    content.steps.flatMap((step) =>
      step.timer ? [[step.timer.id, step.timer.maxSeconds] as const] : [],
    ),
  );

  const checkTemperatures = (path: string, text: string) => {
    for (const value of temperaturesIn(text)) {
      if (!recipeTemperatures.has(value) && !SAFETY_TEMPERATURES.has(value)) {
        errors.push(
          `${path}: temperatury ${value}°C nie ma w przepisie (przepis: ${[...recipeTemperatures].join(', ') || 'brak'}°C)`,
        );
      }
    }
  };

  const general: [string, string][] = content.tips.map((tip, i) => [
    `tips[${i}]`,
    tip,
  ]);
  if (content.nextTimeTip) general.push(['nextTimeTip', content.nextTimeTip]);
  for (const [path, text] of general) {
    checkTemperatures(path, text);
    for (const range of recipeDurations([text])) {
      // Rady mówią też o planie („obiad zajmie wtedy 25 minut”) — do czasu
      // całego scenariusza wolno; dłużej tylko czas z przepisu.
      if (
        range[1] > SHORT_SECONDS &&
        range[1] > content.totalMinutes * 60 &&
        !recipeRanges.some((r) => fitsRange(range, r))
      ) {
        errors.push(
          `${path}: czasu ${describeRange(range)} nie ma w przepisie`,
        );
      }
    }
  }

  for (const step of content.steps) {
    const texts = [
      step.title,
      step.body,
      step.note?.text ?? '',
      step.scaleNote?.text ?? '',
      step.timer?.startLabel ?? '',
      step.timer?.alert.title ?? '',
      step.timer?.alert.body ?? '',
    ].join(' ');
    checkTemperatures(step.id, texts);
    // Krok „Nagrzej piekarnik” mówi, za ile coś do niego trafi — to plan
    // pracy, nie czas obróbki.
    if (OVEN_PREHEAT.test(stepText(step))) continue;
    const own = step.timer?.maxSeconds;
    const during = step.during ? timerMax.get(step.during) : undefined;
    for (const range of recipeDurations([texts])) {
      if (own !== undefined && range[1] > own + tolerance(own)) {
        errors.push(
          `${step.id}: tekst mówi ${describeRange(range)}, a timer kroku ${own} s — tekst i timer muszą się zgadzać`,
        );
        continue;
      }
      const grounded = recipeRanges.some((r) => fitsRange(range, r));
      const withinTimer = [own, during].some(
        (limit) => limit !== undefined && range[1] <= limit + tolerance(limit),
      );
      if (grounded || withinTimer) continue;
      if (range[1] <= SHORT_SECONDS) {
        warnings.push(
          `${step.id}: krótki czas ${describeRange(range)} spoza przepisu`,
        );
      } else {
        errors.push(
          `${step.id}: czasu ${describeRange(range)} nie ma w przepisie`,
        );
      }
    }
  }
}

/**
 * Timery ↔ czasy przepisu jak pary (skojarzenie w grafie dwudzielnym):
 * każdy timer musi mieć WŁASNE wystąpienie pasującego czasu w przepisie.
 * Jedno „20 minut” w przepisie nie uzasadni dwóch timerów po 20 minut.
 */
function checkTimers(
  content: CookScenarioContent,
  recipeRanges: [number, number][],
  errors: string[],
  warnings: string[],
) {
  const timers = content.steps.flatMap((step) =>
    step.timer ? [{ step: step.id, timer: step.timer }] : [],
  );
  const candidates = timers.map(({ timer }) =>
    recipeRanges.flatMap((range, index) =>
      fitsRange([timer.minSeconds, timer.maxSeconds], range) ? [index] : [],
    ),
  );
  const owner = new Array<number>(recipeRanges.length).fill(-1);
  const assign = (timer: number, seen: Set<number>): boolean => {
    for (const range of candidates[timer]) {
      if (seen.has(range)) continue;
      seen.add(range);
      if (owner[range] < 0 || assign(owner[range], seen)) {
        owner[range] = timer;
        return true;
      }
    }
    return false;
  };
  timers.forEach(({ step, timer }, index) => {
    if (assign(index, new Set())) return;
    errors.push(
      candidates[index].length
        ? `${step}.timer „${timer.label}” ${timer.minSeconds}–${timer.maxSeconds} s: przepis ma ten czas mniej razy, niż jest takich timerów`
        : `${step}.timer „${timer.label}” ${timer.minSeconds}–${timer.maxSeconds} s: takiego czasu nie ma w przepisie (przepis: ${
            recipeRanges.map(describeRange).join(', ') || 'brak czasów'
          })`,
    );
  });
  recipeRanges.forEach((range, index) => {
    if (range[1] >= 180 && owner[index] < 0) {
      warnings.push(`czas z przepisu ${describeRange(range)} nie ma timera`);
    }
  });
}

// ── Całość ──────────────────────────────────────────────────────────────

/** Walidatory jakości treści, która już przeszła kształt i sumy. */
export function qualityChecks(
  recipe: WriterRecipe,
  content: CookScenarioContent,
): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const recipeRanges = recipeDurations(recipe.instructions);

  checkNumbersInText(recipe, content, errors);
  checkOven(content, errors);
  checkSafety(recipe, content, errors);
  checkTextClaims(recipe, content, recipeRanges, errors, warnings);
  checkTimers(content, recipeRanges, errors, warnings);

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

/** Obróbka cieplna, czekanie albo technika — wtedy przepis nie jest trywialny. */
const NOT_TRIVIAL =
  /(smaż|piecz|gotuj|zagotuj|dus[zi]|zapiek|grill|opiek|blanszuj|podgrzej|rozgrzej|nagrzej|parz|wrząc|wrzą|wrze|piekarnik|patel|garn|rondel|toster|tostuj|mikrofal|gofr|ubij|wyrabiaj|zagniataj|marynuj|chłodź|lodówk|zamraż|zamroź|odstaw|namocz|przez noc|na noc)/iu;
/** Sprzęt, który nie czyni przepisu nietrywialnym. */
const TRIVIAL_EQUIPMENT = new Set(['BLENDER']);

/**
 * D29: pominąć wolno tylko przepis, o którym WIEMY, że jest samym
 * złożeniem (review Codexa, E3a runda 2 — brak liczby w przepisie to za
 * mało: „smaż do ścięcia” czasu nie podaje). Wszystkie warunki naraz: bez
 * czasów, krótki, bez sprzętu grzejnego i bez słów obróbki, czekania
 * i techniki.
 */
export function skipGuard(recipe: WriterRecipe): string | null {
  if (recipeDurations(recipe.instructions).length) {
    return 'SKIP niedozwolony: przepis ma czasy (gotowanie, pieczenie, chłodzenie) — napisz scenariusz';
  }
  if (recipe.instructions.length > 4 || recipe.prepTimeMinutes > 15) {
    return `SKIP niedozwolony: przepis ma ${recipe.instructions.length} kroków i ${recipe.prepTimeMinutes} min — napisz scenariusz`;
  }
  const equipment = recipe.equipment.filter(
    (item) => !TRIVIAL_EQUIPMENT.has(item),
  );
  if (equipment.length) {
    return `SKIP niedozwolony: przepis wymaga sprzętu (${equipment.join(', ')}) — napisz scenariusz`;
  }
  const found = NOT_TRIVIAL.exec(
    [recipe.title, ...recipe.instructions].join(' '),
  );
  if (found) {
    return `SKIP niedozwolony: przepis ma obróbkę, czekanie albo technikę („${found[0]}”) — napisz scenariusz`;
  }
  return null;
}
