import {
  COOK_AUTHOR_LIMITS,
  COOK_SCENARIO_SCHEMA_VERSION,
  type CookScenarioContent,
} from '../cook-scenario.types';
import {
  checkScenarioAgainstRecipe,
  parseCookScenarioContent,
} from '../cook-scenario.validate';
import { normalizeText } from '../../../common/normalize-text.util';
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
const PL_UPPER = 'A-ZĄĆĘŁŃÓŚŹŻ';
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
/** Aktywna obróbka przy patelni — stoi się przy niej, bez łącznego timera. */
const ACTIVE_PAN = /(smaż|podsmaż|usmaż|opiekaj|obsmaż|patel)/iu;

const PER_SIDE =
  /^\s*(?:[^\s.,;]+\s+){0,2}?z\s+(?:każdej|obu|jednej\s+i\s+drugiej)\s+stron/iu;

/**
 * Czasy przepisu z informacją, które są WYMIENNE: „po X min z każdej
 * strony” = dwa odliczania po X (`singles`) ALBO jedno łączne 2X
 * (`combined`) — nigdy wszystkie trzy (review Codexa).
 */
export interface DurationPool {
  ranges: [number, number][];
  /**
   * `combined` = `null` przy aktywnej obróbce na patelni („smaż po 3 min
   * z każdej strony”): łączny timer odpada — użytkownik stoi przy patelni
   * (review Codexa; prompt: krótka aktywna czynność bez timera).
   */
  perSide: { singles: [number, number]; combined: number | null }[];
}

export function recipeDurations(instructions: string[]): [number, number][] {
  return recipeDurationPool(instructions).ranges;
}

/**
 * Czasy, które tekst NAPRAWDĘ podaje — bez łącznego „z każdej strony”
 * wyliczonego do puli (tekst „po 2 minuty z każdej strony” nie twierdzi,
 * że coś trwa 4 minuty).
 */
function claimedDurations(text: string): [number, number][] {
  const pool = recipeDurationPool([text]);
  const derived = new Set(pool.perSide.map((group) => group.combined));
  return pool.ranges.filter((_, i) => !derived.has(i));
}

/** Koniec zdania: [.!?] i spacja przed wielką literą (nie skrót „ok.”). */
const SENTENCE_BREAK = new RegExp(`[.!?]\\s+(?=[${PL_UPPER}])`, 'gu');

function sentenceStart(line: string, at: number): number {
  let start = 0;
  for (const match of line.matchAll(SENTENCE_BREAK)) {
    const end = (match.index ?? 0) + match[0].length;
    if (end > at) break;
    start = end;
  }
  return start;
}

function sentenceEnd(line: string, at: number): number | undefined {
  for (const match of line.matchAll(SENTENCE_BREAK)) {
    if ((match.index ?? 0) >= at) return match.index;
  }
  return undefined;
}

export function recipeDurationPool(instructions: string[]): DurationPool {
  const found: [number, number][] = [];
  const perSide: DurationPool['perSide'] = [];
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
        const first = found.length - 1;
        // Zdanie, w którym stoi czas — czy to aktywne smażenie na patelni.
        // Granica zdania to kropka przed WIELKĄ literą: „smaż ok. 2 minuty”
        // (skrót „ok.”) to wciąż jedno zdanie (test paczek E3b, gruszka).
        const start = match.index ?? 0;
        const sentence = line.slice(
          sentenceStart(line, start),
          sentenceEnd(line, start),
        );
        found.push(range);
        if (ACTIVE_PAN.test(sentence)) {
          perSide.push({ singles: [first, first + 1], combined: null });
        } else {
          found.push([range[0] * 2, range[1] * 2]);
          perSide.push({ singles: [first, first + 1], combined: first + 2 });
        }
      }
    }
    const lower = line.toLowerCase();
    if (lower.includes('kwadrans')) found.push([900, 900]);
    if (lower.includes('pół godziny')) found.push([1800, 1800]);
    if (lower.includes('półtorej godziny')) found.push([5400, 5400]);
    if (/(^|[^\d\s]\s*)godzinę/.test(lower)) found.push([3600, 3600]);
  }
  return { ranges: found, perSide };
}

const tolerance = (seconds: number) => Math.max(60, seconds * 0.1);

// ── Cyfry i tokeny w tekście ────────────────────────────────────────────

const COUNT_TOKEN = /\{count:[a-z][a-z-]*\|[^|{}]+\|[^|{}]+\|[^|{}]+\}/g;
const NUMBER_IN_TEXT = new RegExp(
  `\\d+(?:[.,]\\d+)?(?:\\s*(?:[–—-]|do)\\s*\\d+(?:[.,]\\d+)?)?`,
  'g',
);
// Wymiar „3 × 4 cm”, „20 x 30 cm” — pierwsza liczba też jest rozmiarem.
const ALLOWED_AFTER_NUMBER = new RegExp(
  `^\\s*(?:min|godz|h(?![${PL}])|sek|s(?![${PL}])|°|stopni|cm|mm|%|[×x]\\s*\\d+(?:[.,]\\d+)?\\s*(?:cm|mm))`,
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
/**
 * Czy ilość w tekście dotyczy składnika z listy (review Codexa): po polsku
 * ilość określa rzeczownik po jednostce, czasem po przymiotnikach („100 ml
 * świeżo wyciśniętego soku”) — sprawdzamy CAŁĄ resztę zdania po jednostce
 * i 1 słowo tuż przed liczbą, i tylko składniki w TEJ
 * SAMEJ jednostce („1,5 l” nie dotyczy masła w gramach). Zachowawczo:
 * fałszywy alarm każe tylko przepisać zdanie bez liczby. Porównanie po pierwszych
 * 3 literach słów nazwy — z zapasem na odmianę („mleko” / „mleka”).
 */
function mentionsIngredient(
  recipe: WriterRecipe,
  text: string,
  numberStart: number,
  unitEnd: number,
  unit: string,
): boolean {
  const words = (fragment: string): string[] =>
    fragment.toLowerCase().match(new RegExp(`[${PL}]+`, 'giu')) ?? [];
  // Do granicy ZDANIA albo nawiasu — przecinek bywa wewnątrz wyrażenia
  // („przegotowanego, zimnego mleka”), a nawias zamyka dopowiedzenie
  // („ciepłej wody (100 ml), oleju” — 100 ml to woda, nie olej).
  const tail = text.slice(unitEnd).split(/[.;:!?()—–]/)[0];
  const around = [
    ...words(text.slice(0, numberStart)).slice(-1),
    ...words(tail),
  ];
  const stems = recipe.ingredients
    .filter((row) => sameUnit(row.unit, unit))
    .flatMap((row) =>
      words(row.name)
        .filter((word) => word.length >= 3)
        .map((word) => word.slice(0, 3)),
    );
  return around.some((word) => stems.some((stem) => word.startsWith(stem)));
}

/**
 * Liczba z jednostką przepisana DOSŁOWNIE z kroków przepisu, która nie
 * jest ilością składnika z listy (pilot E3b, 30.09): „naczynie ok. 1,5 l”,
 * „100 ml zimnej wody”, gdy wody nie ma w składnikach — tego telefon nie
 * pokaże przy kroku, więc tekst musi to powiedzieć. Ilość składnika z listy
 * — całość („320 g”) ALBO część („100 ml mleka” z 200 ml) — nadal tylko
 * przy kroku: w tekście nie przeskalowałaby się z porcjami.
 */
function isRecipeQuantity(
  recipe: WriterRecipe,
  amount: number,
  unit: string,
): boolean {
  const isIngredientAmount = recipe.ingredients.some(
    (row) => row.amount === amount && sameUnit(row.unit, unit),
  );
  if (isIngredientAmount) return false;
  return recipe.instructions.some((line) =>
    [...line.matchAll(QUANTITY_IN_RECIPE)].some((match) => {
      if (toAmount(match[1]) !== amount || !sameUnit(match[2], unit)) {
        return false;
      }
      const start = match.index ?? 0;
      return !mentionsIngredient(
        recipe,
        line,
        start,
        start + match[0].length,
        unit,
      );
    }),
  );
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
      const start = match.index ?? 0;
      const unitEnd =
        start + match[0].length + (UNIT_AFTER.exec(after)?.[0].length ?? 0);
      if (
        unit &&
        single &&
        isRecipeQuantity(recipe, toAmount(match[0]), unit) &&
        // Także w tekście scenariusza liczba nie może stać przy składniku.
        !mentionsIngredient(recipe, value, start, unitEnd, unit)
      ) {
        continue;
      }
      errors.push(
        `${path}: liczba „${match[0]}” w tekście — ilości składników tylko przy kroku, sztuki tokenem {count:…}; cyframi wolno czas, temperaturę, rozmiar albo liczbę z jednostką przepisaną dosłownie z kroków przepisu (np. „1,5 l”, gdy nie jest ilością składnika)`,
      );
    }
  }
}

// ── Pisownia (D32) ──────────────────────────────────────────────────────

/**
 * Słowa kuchenne, które model czasem pisze BEZ polskich znaków (pilot:
 * „kroj” dwa razy przeszło recenzenta). Tylko formy, które same nie są
 * poprawnymi słowami — „cebule”, „soli”, „ze” tu nie trafiają. Lista rośnie
 * z przeglądem; recenzent pilnuje reszty.
 */
const MISSING_DIACRITICS: Record<string, string> = {
  kroj: 'krój',
  pokroj: 'pokrój',
  ukroj: 'ukrój',
  wykroj: 'wykrój',
  kroic: 'kroić',
  wloz: 'włóż',
  poloz: 'połóż',
  odloz: 'odłóż',
  przeloz: 'przełóż',
  doloz: 'dołóż',
  wyloz: 'wyłóż',
  zloz: 'złóż',
  wlacz: 'włącz',
  wylacz: 'wyłącz',
  obroc: 'obróć',
  przewroc: 'przewróć',
  wez: 'weź',
  smaz: 'smaż',
  usmaz: 'usmaż',
  podsmaz: 'podsmaż',
  posol: 'posól',
  osol: 'osól',
  zeszklij: 'zeszklij',
  maslo: 'masło',
  masla: 'masła',
  maslem: 'masłem',
  mieso: 'mięso',
  miesa: 'mięsa',
  miesem: 'mięsem',
  make: 'mąkę',
  maki: 'mąki',
  maka: 'mąka',
  zoltko: 'żółtko',
  zoltka: 'żółtka',
  zolty: 'żółty',
  zlote: 'złote',
  zloty: 'złoty',
  zlota: 'złota',
  lyzka: 'łyżka',
  lyzke: 'łyżkę',
  lyzki: 'łyżki',
  lyzeczka: 'łyżeczka',
  lyzeczke: 'łyżeczkę',
  szczypte: 'szczyptę',
  wode: 'wodę',
  goracy: 'gorący',
  goraca: 'gorąca',
  gorace: 'gorące',
  goracej: 'gorącej',
  goracym: 'gorącym',
  miekki: 'miękki',
  miekka: 'miękka',
  miekkie: 'miękkie',
  srodek: 'środek',
  srodka: 'środka',
  srodku: 'środku',
  sredni: 'średni',
  sredniego: 'średniego',
  sredniej: 'średniej',
  ogien: 'ogień',
  dluzej: 'dłużej',
  krotko: 'krótko',
  pozniej: 'później',
  wczesniej: 'wcześniej',
  juz: 'już',
  moze: 'może',
  az: 'aż',
  zeby: 'żeby',
  rowno: 'równo',
  rowniez: 'również',
  wiecej: 'więcej',
  mniej: 'mniej',
};
// `zeszklij` i `mniej` są poprawne — zostają w mapie tylko jako strażnicy
// przed pomyłką przy dopisywaniu; filtr niżej je pomija.
const TYPO_WORDS = Object.entries(MISSING_DIACRITICS).filter(
  ([wrong, right]) => wrong !== right,
);
const TYPO = new RegExp(
  `(?<![\\p{L}])(${TYPO_WORDS.map(([wrong]) => wrong).join('|')})(?![\\p{L}])`,
  'giu',
);

function checkSpelling(content: CookScenarioContent, errors: string[]) {
  for (const [path, text] of textFields(content)) {
    for (const match of text.matchAll(TYPO)) {
      const right = MISSING_DIACRITICS[match[1].toLowerCase()];
      errors.push(`${path}: pisownia „${match[1]}” → „${right}”`);
    }
  }
}

// ── Etykieta „W MIĘDZYCZASIE” i składniki w tekście (zasady .4) ────────

/**
 * „W MIĘDZYCZASIE” tylko przy kroku, który dzieje się w trakcie timera
 * (`during`). Test paczek E3b: krok ubijania śmietanki z tą etykietą, choć
 * nic nie odliczało — użytkownik szuka timera, którego nie ma.
 */
function checkStageDuring(content: CookScenarioContent, errors: string[]) {
  for (const step of content.steps) {
    // I w drugą stronę (review Codexa): krok w trakcie timera ma DOKŁADNIE tę
    // etykietę — na 76 takich krokach z prób 76/76 już ją miało.
    if (step.during && step.stage?.trim().toUpperCase() !== 'W MIĘDZYCZASIE') {
      errors.push(
        `${step.id}.stage: krok w trakcie timera (\`during\`) ma etykietę „W MIĘDZYCZASIE”`,
      );
    }
    if (step.stage && /MI[EĘ]DZYCZASIE/i.test(step.stage) && !step.during) {
      errors.push(
        `${step.id}.stage: „W MIĘDZYCZASIE” bez \`during\` — krok nie dzieje się w trakcie timera; daj etykietę czynności albo null`,
      );
    }
  }
}

/**
 * Składnik z ilością w kroku musi paść w tekście tego kroku — inaczej
 * telefon pokazuje „sól 1 g”, a użytkownik nie wie, co z nią zrobić (test
 * paczek E3b: sałatka hawajska). Porównanie po 3 pierwszych literach słów
 * nazwy, także w środku słów tekstu („posól” ma „sol”), bez polskich znaków.
 * OSTRZEŻENIE, nie błąd: na 56 scenariuszach 3 z 4 trafień były fałszywe —
 * oboczności („ocet” → „octem”, „mąka” → „w mące”) i synonimy („kmin
 * rzymski” → „kumin”). Błąd wymuszałby poprawki dobrych scenariuszy.
 */
function checkIngredientsNamed(
  recipe: WriterRecipe,
  content: CookScenarioContent,
  warnings: string[],
) {
  const names = new Map(
    recipe.ingredients.map((row) => [row.ingredientId, row.name]),
  );
  for (const step of content.steps) {
    // Tylko tytuł i treść — tam zasada każe wymienić składnik.
    const words = normalizeText(`${step.title} ${step.body}`)
      .split(/[^a-z]+/)
      .filter(Boolean);
    for (const use of step.ingredients) {
      const name = names.get(use.ingredientId);
      if (!name || ingredientNamed(name, words)) continue;
      warnings.push(
        `${step.id}: składnik „${name}” ma w kroku ilość, ale tytuł ani treść kroku go nie wymienia`,
      );
    }
  }
}

/**
 * Treść zaczyna od powtórzenia tytułu („Odcedź i posyp koperkiem” → „Odcedź
 * ziemniaki…”) — ostrzeżenie; review Codexa znalazło to we wzorcu.
 */
function checkTitleEcho(content: CookScenarioContent, warnings: string[]) {
  for (const step of content.steps) {
    const first = (text: string) =>
      normalizeText(text)
        .split(/[^a-z]+/)
        .find(Boolean);
    const verb = first(step.title);
    if (verb && verb === first(step.body)) {
      warnings.push(
        `${step.id}: treść zaczyna od powtórzenia tytułu („${step.title}”)`,
      );
    }
  }
}

/** Przedrostki czasowników: „posól”, „dosyp”, „zalej” — rdzeń stoi za nimi. */
const VERB_PREFIXES = [
  'przy',
  'prze',
  'pod',
  'roz',
  'po',
  'do',
  'za',
  'na',
  'wy',
];

/**
 * Czy któreś słowo tekstu to odmiana słowa z nazwy. Rdzeń od POCZĄTKU słowa
 * (review Codexa: „mak” w środku „do smaku” to nie mąka): 4 litery dla słów
 * dłuższych, 3 dla krótkich — a krótkie mogą urosnąć najwyżej o końcówkę
 * („ser” → „serem”, ale nie „serwuj”).
 */
function ingredientNamed(name: string, words: string[]): boolean {
  const parts = normalizeText(name)
    .split(/[^a-z]+/)
    .filter((word) => word.length >= 3);
  if (parts.length === 0) return true;
  return parts.some((part) => {
    const short = part.length < 5;
    const stem = part.slice(0, short ? 3 : 4);
    return words.some((word) =>
      [
        word,
        ...VERB_PREFIXES.filter((p) => word.startsWith(p)).map((p) =>
          word.slice(p.length),
        ),
      ].some(
        (core) =>
          core.startsWith(stem) && (!short || core.length <= part.length + 2),
      ),
    );
  });
}

/**
 * \`startLabel\` to sam warunek startu na przycisku timera w doku („Gdy woda
 * zawrze”) — czas stoi tuż obok, więc liczba albo „odliczaj” to powtórzenie
 * (zasady .5; wcześniej „Woda wrze — odliczaj 20 min”).
 */
// Wyrażenie czasu, nie każda cyfra (review Codexa): „Śmietana 12%” jest OK.
const TIME_IN_LABEL = new RegExp(
  `${DURATION.source}|odlicz|kwadrans|pół godziny|godzin`,
  'i',
);

function checkStartLabels(content: CookScenarioContent, errors: string[]) {
  for (const step of content.steps) {
    const label = step.timer?.startLabel;
    if (label && TIME_IN_LABEL.test(label)) {
      errors.push(
        `${step.id}.timer.startLabel: „${label}” — sam warunek startu, bez czasu i „odliczaj” (np. „Gdy woda zawrze”)`,
      );
    }
  }
}

/**
 * Limity pisania (zasady .5, \`COOK_AUTHOR_LIMITS\`) — ostrzejsze niż limity
 * formatu, które sprawdza też odczyt starszych zapisów. Treść liczona tak,
 * jak ją widać: token liczby sztuk to ok. 10 znaków („2 kotlety”).
 */
function checkAuthorLimits(content: CookScenarioContent, errors: string[]) {
  const A = COOK_AUTHOR_LIMITS;
  for (const step of content.steps) {
    if (step.title.length > A.title) {
      errors.push(
        `${step.id}.title: ${step.title.length} znaków, limit ${A.title} (dwie linijki na ekranie kroku)`,
      );
    }
    const shown = step.body.replace(COUNT_TOKEN, '1234567890').length;
    if (shown > A.body) {
      errors.push(`${step.id}.body: ${shown} znaków, limit ${A.body}`);
    }
    const label = step.timer?.startLabel;
    if (label && label.length > A.timerStartLabel) {
      errors.push(
        `${step.id}.timer.startLabel: ${label.length} znaków, limit ${A.timerStartLabel} (przycisk timera w doku)`,
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
    return;
  }
  // Rafał 30.09: użytkownik ma wiedzieć, JAK ustawić piekarnik — tryb
  // grzania zawsze w kroku nagrzewania (z przepisu, domyślnie góra–dół).
  if (!OVEN_MODE.test(texts[preheat])) {
    errors.push(
      `${content.steps[preheat].id}: krok nagrzewania nie mówi, jak ustawić piekarnik — napisz tryb (góra–dół, termoobieg, grill); gdy przepis nie mówi, góra–dół`,
    );
  }
}

const OVEN_MODE = /(góra|dół|termoobieg|grill|grzałk|górn|doln|wentylator)/iu;

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
    for (const range of claimedDurations(text)) {
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
    for (const range of claimedDurations(texts)) {
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
  pool: DurationPool,
  errors: string[],
  warnings: string[],
) {
  const recipeRanges = pool.ranges;
  const timers = content.steps.flatMap((step) =>
    step.timer ? [{ step: step.id, timer: step.timer }] : [],
  );
  const fits = (timerIndex: number, range: number) => {
    const { timer } = timers[timerIndex];
    return fitsRange([timer.minSeconds, timer.maxSeconds], recipeRanges[range]);
  };
  const inGroup = new Set(
    pool.perSide.flatMap((g) =>
      g.combined === null ? g.singles : [...g.singles, g.combined],
    ),
  );
  const ordinary = recipeRanges
    .map((_, index) => index)
    .filter((index) => !inGroup.has(index));

  /** Skojarzenie timerów z dozwolonymi wystąpieniami (graf dwudzielny). */
  const match = (allowed: number[]) => {
    const owner = new Map<number, number>();
    const assign = (timer: number, seen: Set<number>): boolean => {
      for (const range of allowed) {
        if (seen.has(range) || !fits(timer, range)) continue;
        seen.add(range);
        const current = owner.get(range);
        if (current === undefined || assign(current, seen)) {
          owner.set(range, timer);
          return true;
        }
      }
      return false;
    };
    const unmatched = timers
      .map((_, index) => index)
      .filter((index) => !assign(index, new Set()));
    return { owner, unmatched };
  };

  // „Z każdej strony” to wybór wariantu PER GRUPA (review Codexa): bez
  // timera / dwa po X / jedno 2X. Sprawdzamy wszystkie kombinacje (grup jest
  // 0–2, więc najwyżej 9) i bierzemy tę, w której wszystko się zgadza —
  // zwykły czas o tej samej długości nie zostanie wzięty za „stronę”.
  type Mode = 'none' | 'singles' | 'combined';
  const combos: Mode[][] = [[]];
  for (let g = 0; g < pool.perSide.length; g += 1) {
    const next: Mode[][] = [];
    for (const combo of combos) {
      const modes: Mode[] =
        pool.perSide[g].combined === null
          ? ['none', 'singles']
          : ['none', 'singles', 'combined'];
      for (const mode of modes) next.push([...combo, mode]);
    }
    combos.splice(0, combos.length, ...next);
  }
  let best: {
    modes: Mode[];
    owner: Map<number, number>;
    unmatched: number[];
    half: number[];
    score: number;
  } | null = null;
  for (const modes of combos) {
    const allowed = [...ordinary];
    pool.perSide.forEach((group, g) => {
      if (modes[g] === 'singles') allowed.push(...group.singles);
      if (modes[g] === 'combined' && group.combined !== null) {
        allowed.push(group.combined);
      }
    });
    const { owner, unmatched } = match(allowed);
    const half = pool.perSide
      .map((group, g) => ({ group, g }))
      .filter(
        ({ group, g }) =>
          modes[g] === 'singles' &&
          group.singles.filter((i) => owner.has(i)).length === 1,
      )
      .map(({ g }) => g);
    // Wariant „dwa po X” bez żadnego odliczania nie ma sensu — nie liczymy
    // go jako trafienia.
    const empty = pool.perSide.filter(
      (group, g) =>
        modes[g] === 'singles' && !group.singles.some((i) => owner.has(i)),
    ).length;
    const score = unmatched.length * 100 + half.length * 10 + empty;
    if (!best || score < best.score) {
      best = { modes, owner, unmatched, half, score };
    }
  }
  const result = best!;

  for (const index of result.unmatched) {
    const { step, timer } = timers[index];
    const any = recipeRanges.some((_, range) => fits(index, range));
    const perSide = pool.perSide.some((group) =>
      [
        ...group.singles,
        ...(group.combined === null ? [] : [group.combined]),
      ].some((range) => fits(index, range)),
    );
    errors.push(
      !any
        ? `${step}.timer „${timer.label}” ${timer.minSeconds}–${timer.maxSeconds} s: takiego czasu nie ma w przepisie (przepis: ${
            recipeRanges.map(describeRange).join(', ') || 'brak czasów'
          })`
        : perSide
          ? `timery dublują czas „z każdej strony” ${describeRange([timer.minSeconds, timer.maxSeconds])}: albo dwa odliczania po tyle, albo jedno łączne — nie oba`
          : `${step}.timer „${timer.label}” ${timer.minSeconds}–${timer.maxSeconds} s: przepis ma ten czas mniej razy, niż jest takich timerów`,
    );
  }
  for (const g of result.half) {
    errors.push(
      `timer „z każdej strony” ${describeRange(recipeRanges[pool.perSide[g].singles[0]])} tylko dla jednej strony — daj dwa odliczania albo jedno łączne`,
    );
  }

  // Ostrzeżenia: zwykły czas bez timera; grupa bez żadnego wariantu — raz,
  // o łącznym czasie.
  for (const index of ordinary) {
    const range = recipeRanges[index];
    if (range[1] >= MIN_TIMER_SECONDS && !result.owner.has(index)) {
      warnings.push(`czas z przepisu ${describeRange(range)} nie ma timera`);
    }
  }
  pool.perSide.forEach((group, g) => {
    if (result.modes[g] !== 'none') return;
    // Bez łącznego wariantu (patelnia) ostrzegamy o czasie jednej strony.
    const range = recipeRanges[group.combined ?? group.singles[0]];
    if (range[1] >= MIN_TIMER_SECONDS) {
      warnings.push(`czas z przepisu ${describeRange(range)} nie ma timera`);
    }
  });
  checkTimerLayout(content, errors);
}

/**
 * Timer tylko na czekanie od 4 minut — krótka, aktywna czynność przy
 * garnku („podsmaż cebulę ok. 3 min”, „smaż po 3 min z każdej strony”)
 * idzie tekstem i sygnałem „po czym poznać”; użytkownik i tak stoi przy
 * patelni (Rafał 30.09: trzy timery naraz = użytkownik się gubi).
 */
export const MIN_TIMER_SECONDS = 240;
/** Najwyżej tyle odliczań naraz — design Dynamic Island ma stany 0/1/2. */
export const MAX_PARALLEL_TIMERS = 2;
/**
 * Kroki „w międzyczasie” mają się zmieścić w swoim timerze PO LUDZKU
 * (Rafał 30.09): minuta czy dwie w tę albo w tamtą niczego nie psuje.
 */
const parallelSlack = (seconds: number) => Math.max(120, seconds * 0.2);

/**
 * Oś czasu scenariusza w NAJGORSZYM wariancie (review Codexa): czynności
 * ręczne trwają zero, odliczania — najdłużej (`maxSeconds`), a krok bez
 * `during` rusza po NAJWCZEŚNIEJSZYM końcu timera kroku głównego przed nim
 * (kontrakt przy `CookStep.during`). W żadnej chwili nie mogą biec więcej
 * niż `MAX_PARALLEL_TIMERS` odliczania — także gdy odliczanie z „w
 * międzyczasie” trwa dłużej niż nadrzędne i zachodzi na kolejne kroki.
 */
function checkTimerTimeline(content: CookScenarioContent, errors: string[]) {
  let active: { id: string; end: number }[] = [];
  let now = 0;
  let waitUntil = 0;
  let waitingFor: string | null = null;
  for (const step of content.steps) {
    if (!step.during) {
      // Krok główny rusza PO alarmie timera poprzedniego kroku głównego —
      // ten timer się skończył, więc już nie biegnie (review Codexa: przy
      // zakresach „10–12 min” liczony do `maxSeconds` dawał fałszywe trzy).
      now = Math.max(now, waitUntil);
      if (waitingFor) {
        const ended = waitingFor;
        active = active.filter((t) => t.id !== ended);
      }
      waitUntil = 0;
      waitingFor = null;
    }
    if (!step.timer) continue;
    const running = active.filter((t) => t.end > now);
    if (running.length + 1 > MAX_PARALLEL_TIMERS) {
      errors.push(
        `${step.id}.timer „${step.timer.label}”: w tej chwili biegną już ${running.length} odliczania (${running
          .map((t) => t.id)
          .join(
            ', ',
          )}) — najwyżej ${MAX_PARALLEL_TIMERS} naraz; przesuń krok albo połącz czynności`,
      );
    }
    active.push({ id: step.timer.id, end: now + step.timer.maxSeconds });
    if (!step.during) {
      waitUntil = now + step.timer.minSeconds;
      waitingFor = step.timer.id;
    }
  }
}

function checkTimerLayout(content: CookScenarioContent, errors: string[]) {
  checkTimerTimeline(content, errors);
  const timers = new Map(
    content.steps.flatMap((step) =>
      step.timer ? [[step.timer.id, { step, timer: step.timer }] as const] : [],
    ),
  );
  for (const { step, timer } of timers.values()) {
    if (timer.minSeconds < MIN_TIMER_SECONDS) {
      errors.push(
        `${step.id}.timer „${timer.label}” ${timer.minSeconds} s: krótsze niż 4 min — bez timera, napisz czas w treści i po czym poznać koniec`,
      );
    }
    // Ile odliczań biegnie naraz: timer + łańcuch timerów, w trakcie których
    // startuje. Rodzeństwo pod tym samym timerem idzie po kolei.
    let depth = 1;
    let parent = step.during ? timers.get(step.during) : undefined;
    const seen = new Set([timer.id]);
    while (parent && !seen.has(parent.timer.id)) {
      seen.add(parent.timer.id);
      depth += 1;
      parent = parent.step.during ? timers.get(parent.step.during) : undefined;
    }
    if (depth > MAX_PARALLEL_TIMERS) {
      errors.push(
        `${step.id}.timer „${timer.label}”: to ${depth}. odliczanie naraz — najwyżej ${MAX_PARALLEL_TIMERS}; połącz czynności albo przesuń krok`,
      );
    }
  }
  // Pod jednym timerem najwyżej JEDNO odliczanie „w międzyczasie” — model
  // danych nie wymusza, że drugie startuje po końcu pierwszego, więc dwa
  // takie kroki to potencjalnie trzy odliczania naraz (review Codexa).
  for (const { step, timer } of timers.values()) {
    const withTimers = content.steps.filter(
      (other) => other.during === timer.id && other.timer,
    );
    if (withTimers.length > 1) {
      errors.push(
        `${step.id}.timer „${timer.label}”: pod nim ${withTimers.length} kroki z własnym odliczaniem (${withTimers
          .map((other) => other.id)
          .join(
            ', ',
          )}) — najwyżej jeden; kolejny zacznij po końcu poprzedniego (bez „w międzyczasie”) albo połącz czynności`,
      );
    }
  }

  // Odliczania startowane po kolei pod jednym timerem: wszystkie POZA
  // OSTATNIM muszą się w nim zmieścić (ostatnie może biec dalej samo, jak
  // ziemniaki nastawione, gdy masło chłodzi się w zamrażarce).
  for (const { step, timer } of timers.values()) {
    const children = content.steps.filter(
      (other) => other.during === timer.id && other.timer,
    );
    const before = children.slice(0, -1);
    const needed = before.reduce(
      (sum, other) => sum + (other.timer?.minSeconds ?? 0),
      0,
    );
    if (needed > timer.maxSeconds + parallelSlack(timer.maxSeconds)) {
      errors.push(
        `${step.id}.timer „${timer.label}” ${timer.maxSeconds} s: odliczania „w międzyczasie” (${before
          .map((other) => other.id)
          .join(
            ', ',
          )}) trwają po kolei co najmniej ${needed} s — nie zmieszczą się; przesuń je albo zacznij wcześniej`,
      );
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
  const pool = recipeDurationPool(recipe.instructions);
  const recipeRanges = pool.ranges;

  checkNumbersInText(recipe, content, errors);
  checkSpelling(content, errors);
  checkStageDuring(content, errors);
  checkStartLabels(content, errors);
  checkAuthorLimits(content, errors);
  checkIngredientsNamed(recipe, content, warnings);
  checkTitleEcho(content, warnings);
  checkOven(content, errors);
  checkSafety(recipe, content, errors);
  checkTextClaims(recipe, content, recipeRanges, errors, warnings);
  checkTimers(content, pool, errors, warnings);

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
