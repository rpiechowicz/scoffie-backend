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
 * Błąd kształtu tak, żeby autor wiedział, CO poprawić (próba .5: autor trzy
 * razy oddał tę samą 15-znakową etykietę, bo dostał „steps[5].timer.label:
 * 15 znaków, limit 14” — bez id kroku i bez tekstu): `steps[5]` → id kroku,
 * przy przekroczonym limicie — cytat napisu.
 */
function forAuthor(error: string, scenario: Rec): string {
  const match =
    /^((?:steps|tips)\[\d+\](?:\.[A-Za-z]+|\[\d+\])*|nextTimeTip)((?: \([^)]*\))?:.*)$/.exec(
      error,
    );
  if (!match) return error;
  const [, path, rest] = match;
  let value: unknown = scenario;
  for (const part of path.match(/[A-Za-z]+|\d+/g) ?? []) {
    value =
      isRecord(value) || Array.isArray(value)
        ? (value as Record<string, unknown>)[part]
        : undefined;
  }
  const stepIndex = /^steps\[(\d+)\]/.exec(path);
  const step = stepIndex
    ? (scenario.steps as unknown[])[Number(stepIndex[1])]
    : undefined;
  const where =
    stepIndex && isRecord(step) && typeof step.id === 'string'
      ? path.replace(stepIndex[0], step.id)
      : path;
  const quote =
    typeof value === 'string' && /znaków, limit/.test(rest)
      ? ` „${value}”`
      : '';
  const hint = quote ? ' — skróć, np. usuń jedno słowo' : '';
  return `${where}${quote}${rest}${hint}`;
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
    return {
      decision: 'WRITE',
      skipReason: null,
      content: null,
      errors: errors.map((error) => forAuthor(error, scenario)),
    };
  }
  const consistency = checkScenarioAgainstRecipe(parsed.content, {
    servings: recipe.servings,
    ingredients: recipe.ingredients,
  });
  return {
    decision: 'WRITE',
    skipReason: null,
    content: consistency.length ? null : parsed.content,
    errors: consistency.map((error) => forAuthor(error, scenario)),
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
/**
 * Czas złożony „2 godziny 15 minut”, „1 h 30 min”, „1 godzinę i 15 minut”
 * (agenci 2.10: duszenie 2 h 15 min). `DURATION` widzi w nim dwa osobne
 * czasy; timer na sumę (8100 s) nie miał pokrycia w przepisie. Liczba godzin
 * całkowita, tuż przed jednostką, nie koniec zakresu, bez przechodzenia przez
 * kropkę (recenzja 3.10: „stronach 10 minut” dawało 1 h 10 min, „1,5 godziny
 * 10 minut” — 5 h, „1–2 godziny 15 minut” — sumę z połowy zakresu, „2 godziny.
 * 15 minut przed końcem” — sumę przez granicę zdania). Bez samego „godzinę”:
 * jej 3600 s dopisuje osobna reguła, poza grupą „części albo suma”.
 */
const COMPOUND_DURATION =
  /(?<!\p{L})(?<![\d.,–—-]\s*)(\d+)\s*(?:godz(?:\.|\p{L}*)|h(?!\p{L}))\s*(?:i\s+)?(\d+)\s*min\p{L}*/giu;

/** Zakresy czasów [min, max] w sekundach wymienione w krokach przepisu. */
/** Aktywna obróbka przy patelni — stoi się przy niej, bez łącznego timera. */
const ACTIVE_PAN = /(smaż|podsmaż|usmaż|opiekaj|obsmaż|patel)/iu;
/**
 * Aktywna praca rąk albo przy patelni — bez timera (prompt). Zdanie
 * z czekaniem („duś pod przykryciem”, „gotuj, mieszając”) aktywne nie jest
 * (przegląd nocny: samo „patel”/„mieszając” zabierało recenzentowi sygnał).
 */
const ACTIVE_WORK =
  /(smaż|podsmaż|usmaż|opiekaj|obsmaż|szklij|podgrzej|podgrzew|wyrabiaj|zagniataj|ugniataj|miksuj|ubijaj)/iu;
/** Praca w turach — ten sam czas z przepisu dla każdej tury. */
const BATCH_WORK =
  /(po\s+(?:\d+|dwa|dwie|trzy|cztery)\s+naraz|partiami|porcjami|kolejne\s+parti|w\s+(?:\d+(?:[–-]\d+)?|dwóch|kilku|trzech)\s+turach|turami|w\s+dwóch\s+partiach)/iu;
/**
 * „Wlewaj partiami po chochli” to dolewanie płynu stopniowo, nie tury
 * (kaszotto). Wrzucanie („wsyp pierogi partiami do wrzątku”) to tury.
 */
const ADDING_GRADUALLY = /(wlew|dolew|chochl)/iu;
/** „Porcjami” to tury tylko przy obróbce („podawaj porcjami” — nie). */
const COOKING_TURN = /(piecz|gotuj|smaż|grilluj|opiekaj|gofr|wrząt)/iu;
/**
 * Ile dodatkowych tur tym samym czasem: „w dwóch turach/partiach” — jedna,
 * inaczej najwyżej dwie (prompt: najwyżej trzy tury z timerem).
 */
const extraTurnsIn = (sentence: string): number =>
  /w\s+(?:dwóch|2)\s+(?:turach|partiach)|drug[iąaey]/iu.test(sentence) ? 1 : 2;
/**
 * Tura nazwana wprost, bez słów z `BATCH_WORK` (agenci 2.10, katalog:
 * „piecz każdy gofr 4–5 minut”, „piecz każdą partię 3–4 minuty”, „Tak samo
 * usmaż drugi omlet” — w omletach ZWYKLE w następnym kroku, bez czasu).
 * Tylko dopuszcza drugi timer tej samej długości — nie każe go dawać.
 */
/** Powtórka w NASTĘPNYM kroku — tylko jawne „tak samo usmaż/upiecz…”. */
const TURN_REPEAT_NEXT =
  /tak\s+samo\s+(?:u|przy|za)?(?:smaż|piecz|gotuj|grilluj|opiekaj)/iu;
const TURN_REPEAT =
  /tak\s+samo\s+(?:u|przy|za)?(?:smaż|piecz|gotuj|grilluj|opiekaj)|(?:każd\p{L}*|kolejn\p{L}*|następn(?!ie(?!\p{L}))\p{L}*)\s+(?:\p{L}+\s+)?(?:parti|porcj|tur[ęy]|blach|gofr|omlet|plac|naleśnik|tortill|pizz|racuch|blin|pancake|kotlet|burger)/iu;
const WAITING_WORK =
  /(duś|dus[zi]|gotuj|piecz|zapiekaj|pod\s+przykryciem|odstaw|marynuj|chłodź|mroź)/iu;

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
  /**
   * Indeksy `ranges` dopisane dla kolejnych tur („piecz po 2 naraz”) —
   * pozwalają na drugi timer tej samej długości, ale bez nich nie ma
   * ostrzeżenia „nie ma timera”.
   */
  extraTurns: Set<number>;
  /**
   * Indeksy `ranges` ze zdań o AKTYWNEJ pracy („smaż 5 minut, mieszając”,
   * „wyrabiaj 8–10 minut”) — prompt każe je pisać bez timera, więc brak
   * timera to nie sygnał dla recenzenta (pomiar na próbie .5: 15 z 17
   * ostrzeżeń „nie ma timera” to była właśnie aktywna praca).
   */
  active: Set<number>;
  /**
   * Indeksy `ranges` z sumy czasu złożonego („2 godziny 15 minut” → 8100 s).
   * Dopuszczają timer na całość, ale tekst ich nie „twierdzi” — scenariusz
   * z timerem do punktu kontrolnego („Zostało 15 minut duszenia”) przechodził
   * dotąd i ma przechodzić (regresja na 1046 scenariuszach, 3.10.2026).
   */
  compound: { parts: number[]; whole: number }[];
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
  const wholes = new Set(pool.compound.map((group) => group.whole));
  return pool.ranges.filter((_, i) => !derived.has(i) && !wholes.has(i));
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

/**
 * Zdanie DRUGIEGO wariantu urządzenia (review Codexa, noc 30.09): 59
 * przepisów katalogu kończy krok airfryera zdaniem „W piekarniku: 190°C,
 * 20–22 minuty.”. Kroki i timery prowadzą PIERWSZY wariant (prompt), więc
 * czasy i temperatury z takiego zdania wolno podać tylko w radzie kucharza
 * — inaczej „piecz w airfryerze w 190°C 20–22 min” przeszłoby, bo obie
 * liczby są „gdzieś w przepisie”.
 */
const VARIANT_SENTENCE =
  /^W\s+(?:piekarniku|airfryerze|mikrofalówce|garnku|szybkowarze)\s*:/u;

export interface RecipeVariants {
  /** Kroki przepisu bez zdań drugiego wariantu — źródło kroków i timerów. */
  primary: string[];
  /** Same zdania drugiego wariantu — wolno z nich tylko w radach. */
  alternative: string[];
}

export function splitRecipeVariants(instructions: string[]): RecipeVariants {
  const primary: string[] = [];
  const alternative: string[] = [];
  for (const line of instructions) {
    const sentences: string[] = [];
    let start = 0;
    for (const match of line.matchAll(SENTENCE_BREAK)) {
      const end = (match.index ?? 0) + match[0].length;
      sentences.push(line.slice(start, end));
      start = end;
    }
    sentences.push(line.slice(start));
    const main = sentences.filter((s) => !VARIANT_SENTENCE.test(s.trim()));
    alternative.push(
      ...sentences
        .filter((s) => VARIANT_SENTENCE.test(s.trim()))
        .map((s) => s.trim()),
    );
    const kept = main.join('').trim();
    if (kept) primary.push(kept);
  }
  return { primary, alternative };
}

export function recipeDurationPool(instructions: string[]): DurationPool {
  const found: [number, number][] = [];
  const perSide: DurationPool['perSide'] = [];
  const active = new Set<number>();
  const extraTurns = new Set<number>();
  const compound: DurationPool['compound'] = [];
  instructions.forEach((line, index) => {
    // Powtórka w następnym kroku bez własnego czasu („Tak samo usmaż drugi
    // omlet”) dotyczy czasów TEGO kroku.
    const next = instructions[index + 1] ?? '';
    const repeatedNext =
      TURN_REPEAT_NEXT.test(next) &&
      !new RegExp(DURATION.source, 'iu').test(next);
    // Gdzie w linii stoi każdy czas — części czasu złożonego.
    const spans: { start: number; end: number; index: number }[] = [];
    for (const match of line.matchAll(DURATION)) {
      const seconds = unitSeconds(match[3]);
      const from = toNumber(match[1]) * seconds;
      const to = match[2] ? toNumber(match[2]) * seconds : from;
      const range: [number, number] = [Math.min(from, to), Math.max(from, to)];
      const at = match.index ?? 0;
      const own = line.slice(sentenceStart(line, at), sentenceEnd(line, at));
      if (ACTIVE_WORK.test(own) && !WAITING_WORK.test(own)) {
        active.add(found.length);
      }
      spans.push({ start: at, end: at + match[0].length, index: found.length });
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
      } else if (
        (BATCH_WORK.test(own) &&
          !ADDING_GRADUALLY.test(own) &&
          (!/porcjami/iu.test(own) || COOKING_TURN.test(own))) ||
        TURN_REPEAT.test(own) ||
        repeatedNext
      ) {
        // Kolejne tury tym samym czasem (najwyżej trzy z timerem, więcej —
        // tekstem). Dopisane PO grupie „z każdej strony” i tylko bez niej —
        // kopia przed grupą przesuwała jej indeksy (przegląd nocny).
        const context = repeatedNext ? `${own} ${next}` : own;
        for (let turn = 0; turn < extraTurnsIn(context); turn += 1) {
          extraTurns.add(found.length);
          found.push(range);
        }
      }
    }
    for (const match of line.matchAll(COMPOUND_DURATION)) {
      const seconds = toNumber(match[1]) * 3600 + toNumber(match[2]) * 60;
      const from = match.index ?? 0;
      const to = from + match[0].length;
      compound.push({
        parts: spans
          // Po początku: `DURATION` bierze kropkę po „minut.”, suma — nie.
          .filter((span) => span.start >= from && span.start < to)
          .map((span) => span.index),
        whole: found.length,
      });
      found.push([seconds, seconds]);
    }
    const lower = line.toLowerCase();
    if (lower.includes('kwadrans')) found.push([900, 900]);
    if (lower.includes('pół godziny')) found.push([1800, 1800]);
    if (lower.includes('półtorej godziny')) found.push([5400, 5400]);
    if (/(^|[^\d\s]\s*)godzinę/.test(lower)) found.push([3600, 3600]);
  });
  return { ranges: found, perSide, active, extraTurns, compound };
}

const tolerance = (seconds: number) => Math.max(60, seconds * 0.1);

// ── Cyfry i tokeny w tekście ────────────────────────────────────────────

const COUNT_TOKEN = /\{count:[a-z][a-z-]*\|[^|{}]+\|[^|{}]+\|[^|{}]+\}/g;
/** Najdłuższa forma w tokenie — „wałeczków” ma 9, zapas na złożone nazwy. */
const COUNT_FORM_MAX = 20;
/** Formy odmiany z tokenu `{count:id|1|2-4|5+}`. */
const countForms = (token: string): string[] =>
  token.slice(1, -1).split('|').slice(1);
/**
 * Tekst tak długi, jak go zobaczy telefon: token → liczba (do 3 cyfr),
 * spacja i NAJDŁUŻSZA forma (review Codexa, noc 30.09).
 */
export const shownLength = (text: string): number =>
  text.replace(COUNT_TOKEN, (token) =>
    'x'.repeat(4 + Math.max(...countForms(token).map((f) => f.length))),
  ).length;
const NUMBER_IN_TEXT = new RegExp(
  `\\d+(?:[.,]\\d+)?(?:\\s*(?:[–—-]|do)\\s*\\d+(?:[.,]\\d+)?)?`,
  'g',
);
// Wymiar „3 × 4 cm”, „20 x 30 cm” — pierwsza liczba też jest rozmiarem.
// Czas przechowywania („do 5 dni”, „2 tygodnie”) to też czas (próba .5:
// kulki proteinowe).
const ALLOWED_AFTER_NUMBER = new RegExp(
  `^\\s*(?:min|godz|h(?![${PL}])|sek|s(?![${PL}])|dni(?![${PL}])|dzień|dnia|tydz|tygod|miesi|°|stopni|cm|mm|%|[×x]\\s*\\d+(?:[.,]\\d+)?\\s*(?:cm|mm))`,
  'iu',
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

type Dimension = 'mass' | 'volume' | 'count' | 'pinch';
/**
 * Jednostka w formie kanonicznej i jej wymiar (przegląd nocny: porównanie
 * prefiksem robiło z „g” składnika „1 godzinę” z przepisu, a samo porównanie
 * jednostek przepuszczało „2 łyżki oliwy”, gdy oliwa jest w ml).
 */
const UNIT_FORMS: [RegExp, string, Dimension][] = [
  [/^(g|gr|gram|gramy|gramów|grama|gramach)$/u, 'g', 'mass'],
  [/^(kg|kilogram\p{L}*)$/u, 'kg', 'mass'],
  [/^(ml|mililitr\p{L}*)$/u, 'ml', 'volume'],
  [/^(l|litr|litry|litrów|litra|litrze)$/u, 'l', 'volume'],
  [/^(łyżeczk\p{L}*|łyżeczek)$/u, 'łyżeczka', 'volume'],
  [/^(łyżk\p{L}*|łyżek)$/u, 'łyżka', 'volume'],
  [/^(szklank\p{L}*|szklanek)$/u, 'szklanka', 'volume'],
  // Szczypta to osobna miara, nie objętość — sól „1 szczypta” nie może
  // „pasować” do ilości w ml (fala 1: krem z dyni, naleśniki).
  [/^(szczypt\p{L}*)$/u, 'szczypta', 'pinch'],
  [/^(szt|sztuk\p{L}*)$/u, 'szt', 'count'],
];
/** Miary kuchenne — mogą dotyczyć składnika w DOWOLNEJ jednostce listy. */
const KITCHEN_MEASURES = new Set(['łyżka', 'łyżeczka', 'szklanka', 'szczypta']);

interface UnitInfo {
  canon: string;
  dim: Dimension;
  /** Słowo po liczbie, które NIE jest jednostką — to rzecz („2 jajka”). */
  noun: string | null;
}
const unitInfo = (unit: string): UnitInfo => {
  const x = unit.toLowerCase();
  const hit = UNIT_FORMS.find(([form]) => form.test(x));
  return hit
    ? { canon: hit[1], dim: hit[2], noun: null }
    : { canon: x, dim: 'count', noun: x };
};
const sameUnit = (a: string, b: string) =>
  unitInfo(a).canon === unitInfo(b).canon;

const normalizedWords = (fragment: string): string[] =>
  normalizeText(fragment)
    .split(/[^a-z]+/)
    .filter(Boolean);

/** Końcówki dopełniacza — po „i” ta sama ilość dotyczy też tej rzeczy. */
const GENITIVE_END = /(a|y|i|u|ego|ej|ów|ich|ych)$/u;
/**
 * Końcówki przymiotnika (bez polskich znaków) albo przysłówka przed nim
 * („drobno mielonej soli”) — rzecz stoi dalej. Szerzej = surowiej: więcej
 * słów porównujemy z każdym składnikiem.
 */
const ADJECTIVE_END = /(ej|ego|ych|ich|ymi|imi|nej|wej|tej|o)$/u;
/** Końcówki trybu rozkazującego (bez polskich znaków): dodaj, wsyp, gotuj, zmniejsz, wloz. */
const IMPERATIVE_END = /(aj|ej|ij|uj|yj|sz|cz|oz|uc|ol)$/u;
/**
 * Przysłówki o tej samej końcówce („, najlepiej mleka”, „, raczej mleka”) —
 * nie zaczynają nowej czynności (recenzja 3.10). Stopień wyższy („-iej”)
 * odcina osobny warunek.
 */
const NOT_IMPERATIVE = new Set(['raczej', 'dalej', 'wiecej', 'juz', 'tez']);
/** Słowa, po których w wyliczeniu zaczyna się NOWA pozycja. */
const LIST_JOINERS = new Set(['i', 'a', 'oraz', 'lub', 'albo', 'z', 'ze']);

/**
 * Reszta zdania po jednostce, której dotyczy ilość: do granicy zdania,
 * nawiasu albo nowej części po przecinku („, a potem”). Na „i / oraz” tnie
 * tylko przed nową rzeczą w bierniku („120 ml letniej wody i oliwę” — ilość
 * wody); przed dopełniaczem nie („150 ml wody i mleka kokosowego” — ilość
 * obu; przegląd nocny). Na „albo / lub” nigdy: alternatywa dzieli ilość.
 */
function quantityTail(rest: string): string {
  // Po „z / ze” stoi źródło, nie odmierzana rzecz: „2–3 łyżki wody
  // z makaronu” to ilość wody (przegląd nocny). Przecinek frazy nie kończy
  // („przegotowanego, zimnego mleka”) — cięcie na „, polecenie” otwierało
  // obejścia („Odmierz 50 ml czystą miarką, wlej olej”; review Codexa
  // #265), a fałszywe alarmy fali 1 usuwa już osobny wymiar szczypty.
  const clause = rest.split(
    /[.;:!?()—–]|,\s*(?:a|potem|następnie|później)\s|\s(?:z|ze)\s/u,
  )[0];
  for (const match of clause.matchAll(/\s(?:i|oraz)\s+(\p{L}+)/gu)) {
    // Po „i” określenie tej samej rzeczy („zimnej i drobno mielonej soli”)
    // frazy nie kończy (review Codexa #265).
    const next = match[1].toLowerCase();
    if (!GENITIVE_END.test(next) && !ADJECTIVE_END.test(normalizeText(next))) {
      return clause.slice(0, match.index);
    }
  }
  return clause;
}

/**
 * Czy ilość w tekście dotyczy składnika z listy (review Codexa): po polsku
 * ilość określa rzeczownik po jednostce, czasem po przymiotnikach („100 ml
 * świeżo wyciśniętego soku”) albo tuż przed nawiasem („olej (30 ml)”).
 * Składniki — w tym samym WYMIARZE (masa, objętość, sztuki); miara kuchenna
 * i rzeczownik zamiast jednostki („2 jajka”) — każdy składnik. Zachowawczo:
 * fałszywy alarm każe tylko przepisać zdanie bez liczby. Porównanie po
 * pierwszych 3 literach słów nazwy, bez polskich znaków („sól” ↔ „soli”).
 */
function mentionsIngredient(
  recipe: WriterRecipe,
  text: string,
  numberStart: number,
  unitEnd: number,
  unit: string,
): boolean {
  const info = unitInfo(unit);
  const tail = quantityTail(text.slice(unitEnd));
  // Słowo tuż przed liczbą (albo przed nawiasem z liczbą) — tylko z tej
  // samej pozycji wyliczenia: po „, ” albo „i” zaczyna się nowa pozycja
  // („z mlekiem kokosowym, 150 ml wody”, „bulion warzywny i 300 ml wody”).
  // Bez określników tuż przed liczbą („olej (ok. 30 ml)”, review Codexa).
  // Wszystkie po kolei („po około 30 ml”).
  let before = text.slice(0, numberStart);
  for (let i = 0; i < 4; i += 1) {
    before = before.replace(
      /(^|[^\p{L}])(ok|około|ca|po|co\s+najmniej)\.?\s*$/iu,
      '$1',
    );
  }
  // „olej (30 ml)” — w nawiasie liczba dopowiada rzecz tuż przed nim.
  const bracketed = /\(\s*$/u.test(before);
  const prefix = before
    .replace(/\(\s*$/u, '')
    .split(/[,;:.()—–]/)
    .pop();
  const last = normalizedWords(prefix ?? '').pop();
  const tailWords = normalizedWords(tail);
  // Rzecz TUŻ przy liczbie (słowo przed nią, dwa po jednostce, słowo
  // zamiast jednostki) — porównanie z KAŻDYM składnikiem, bez względu na
  // wymiar: „50 ml soli” to ilość soli, choć sól jest w szczyptach (review
  // Codexa, #265). Dalsza część zdania — tylko składniki w tym wymiarze.
  // Po jednostce: pierwsze słowo, a za przymiotnikiem lub przysłówkiem
  // kolejne — aż do rzeczownika („50 ml bardzo drobno mielonej soli”); nie
  // dalej, bo tam zaczyna się następna czynność („1,5 l wysmaruj masłem”).
  let reach = 1;
  while (
    reach < tailWords.length &&
    (ADJECTIVE_END.test(tailWords[reach - 1]) ||
      // „zimnej i drobno mielonej soli” — spójnik między określeniami
      ['i', 'oraz'].includes(tailWords[reach - 1]))
  ) {
    reach += 1;
  }
  // Słowo przed liczbą to zwykle dopełnienie czasownika („Zalej żelatynę
  // 100 ml wody” — ilość wody), więc idzie z filtrem wymiaru; tylko przed
  // nawiasem to sama rzecz.
  const lastWord = last && !LIST_JOINERS.has(last) ? [last] : [];
  // Ilość WODY (nie ma jej na liście składników) kończy się na „, nowa
  // czynność” — „Zagotuj 1,5 l wody, dodaj ocet”, „zalej 300 ml wody, dodaj
  // liść laurowy” (agenci 2.10, katalog). Tylko przed czasownikiem, który
  // nie jest nazwą składnika: „150 ml wody i/lub mleka” dalej dzieli ilość,
  // a „50 ml czystą miarką, wlej olej” (review Codexa #265) — nie woda.
  let farWords = tailWords.slice(reach);
  if (/^(wod|wrz)/.test(tailWords[reach - 1] ?? '')) {
    const cut = /,\s*(\p{L}+)/u.exec(tail);
    const verb = cut ? normalizeText(cut[1]) : '';
    const isIngredient = recipe.ingredients.some((row) =>
      normalizedWords(row.name).some(
        (word) => word.length >= 3 && verb.startsWith(word.slice(0, 3)),
      ),
    );
    if (
      cut &&
      IMPERATIVE_END.test(verb) &&
      !/iej$/.test(verb) &&
      !NOT_IMPERATIVE.has(verb) &&
      !isIngredient
    ) {
      farWords = normalizedWords(tail.slice(0, cut.index)).slice(reach);
    }
  }
  const near = [
    ...(bracketed ? lastWord : []),
    ...tailWords.slice(0, reach),
    ...(info.noun ? normalizedWords(info.noun) : []),
  ];
  const stemsOf = (rows: WriterRecipe['ingredients']) =>
    rows.flatMap((row) =>
      normalizedWords(row.name)
        .filter((word) => word.length >= 3)
        .map((word) => word.slice(0, 3)),
    );
  const all = stemsOf(recipe.ingredients);
  const sameDimension = stemsOf(
    recipe.ingredients.filter(
      (row) =>
        Boolean(info.noun) ||
        KITCHEN_MEASURES.has(info.canon) ||
        unitInfo(row.unit).dim === info.dim,
    ),
  );
  const hits = (words: string[], stems: string[]) =>
    words.some((word) => stems.some((stem) => word.startsWith(stem)));
  return (
    hits(near, all) ||
    hits([...(bracketed ? [] : lastWord), ...farWords], sameDimension)
  );
}

/** Słowa bez znaczenia dla „czego dotyczy ilość”: czasowniki i określniki. */
const THING_STOP = new Set([
  'ok',
  'okolo',
  'ca',
  'bardzo',
  'lekko',
  'dobrze',
  'mocno',
  'drobno',
  'grubo',
  'swiezo',
  'cienko',
  'po',
  'co',
  'najmniej',
  'najwyzej',
  'kazdy',
  'kazda',
  'kazde',
  'kazdej',
  'kazdego',
  'maksymalnie',
  'mniej',
  'wiecej',
  'tylko',
  'razem',
  'lacznie',
  'wlej',
  'wlewaj',
  'dolej',
  'dolewaj',
  'nalej',
  'odlej',
  'przelej',
  'zalej',
  'dodaj',
  'dodawaj',
  'wsyp',
  'wsypuj',
  'dosyp',
  'wymieszaj',
  'przeloz',
  'wysmaruj',
  'przygotuj',
  'uzyj',
  'wez',
  'odmierz',
  'wstaw',
  'podgrzej',
  'zagotuj',
  'gotuj',
  'zachowaj',
  'zostaw',
  'odstaw',
  'trafia',
  'beda',
  'bedzie',
  'potrzebujesz',
]);

/**
 * Rzecz, której dotyczy liczba z jednostką: rdzenie (3 litery) do 3 słów
 * PO jednostce i do 3 słów PRZED liczbą — bez czasowników i określników,
 * bez „ok.”, „po”, nawiasu, myślnika i dwukropka tuż przed liczbą
 * („Dolej wody – ok. 150 ml”, „naczynie (ok. 1,5 l)”, „foremek (po około
 * 100 ml)”). „Wrzątek” to też woda.
 */
function quantityThing(text: string, numberStart: number, unitEnd: number) {
  const stems = (fragment: string) =>
    normalizedWords(fragment)
      .filter((word) => word.length >= 3 && !THING_STOP.has(word))
      .map((word) => word.slice(0, 3))
      .flatMap((stem) => (stem === 'wrz' ? ['wrz', 'wod'] : [stem]));
  const after = stems(
    text.slice(unitEnd).split(/[,.;:!?()—–]|\s(?:i|a|oraz|albo|lub)\s/u)[0],
  ).slice(0, 3);
  let prefix = text.slice(0, numberStart);
  for (let i = 0; i < 4; i += 1) {
    prefix = prefix
      .replace(/(^|[^\p{L}])(ok|około|ca|po|co\s+najmniej)\.?\s*$/iu, '$1')
      .replace(/[(–—:-]\s*$/u, '');
  }
  const before = stems(prefix.split(/[,.;!?()]/u).pop() ?? '').slice(-3);
  return [...new Set([...after, ...before])];
}

/**
 * Dosłowne ilości z kroków przepisu, które NIE są ilością składnika —
 * dla każdej: rzecz, której dotyczy („300 ml wody” → „wod”). Scenariusz
 * może tę liczbę powtórzyć tylko przy tej samej rzeczy (przegląd nocny:
 * „Wlej passatę (300 ml)”, „Wlej 300 ml przecieru” czy „300 ml i zagotuj”
 * przemycały ilość składnika, która nie skaluje się z porcjami). Zakres
 * („2–3 łyżki wody”) — ten sam zakres w przepisie.
 */
function recipeLiterals(
  recipe: WriterRecipe,
  amount: number,
  unit: string,
  lower: number | null = null,
): string[][] {
  // Bez wczesnego „ta sama ilość co składnik = zakaz” (próba .6: passata
  // 300 ml blokowała dosłowne „300 ml wody” z przepisu, a recenzent go
  // żądał — gulasz i pudding chia odrzucone).
  return recipe.instructions.flatMap((line) =>
    [...line.matchAll(QUANTITY_IN_RECIPE)].flatMap((match) => {
      if (toAmount(match[1]) !== amount || !sameUnit(match[2], unit)) {
        return [];
      }
      const start = match.index ?? 0;
      if (lower !== null) {
        const range = /(\d+(?:[.,]\d+)?)\s*[–—-]\s*$/u.exec(
          line.slice(0, start),
        );
        if (!range || toAmount(range[1]) !== lower) return [];
      }
      const end = start + match[0].length;
      if (mentionsIngredient(recipe, line, start, end, unit)) return [];
      return [quantityThing(line, start, end)];
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
    const tokens = raw.match(COUNT_TOKEN) ?? [];
    // Review Codexa (noc 30.09): telefon podstawia liczbę TYLKO w treści
    // kroku — token w tytule, alarmie czy etykiecie zostałby surowym tekstem.
    if (tokens.length && !/^[^.]+\.body$/.test(path)) {
      errors.push(
        `${path}: token {count:…} wolno tylko w treści kroku (body) — tu napisz bez liczby („każdy kotlet”)`,
      );
    }
    for (const token of tokens) {
      const longest = Math.max(...countForms(token).map((f) => f.length));
      if (longest > COUNT_FORM_MAX) {
        errors.push(
          `${path}: forma w tokenie ${token} ma ${longest} znaków — najwyżej ${COUNT_FORM_MAX}`,
        );
      }
    }
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
      const numbers = match[0].match(/\d+(?:[.,]\d+)?/g) ?? [];
      const start = match.index ?? 0;
      const unitEnd =
        start + match[0].length + (UNIT_AFTER.exec(after)?.[0].length ?? 0);
      if (unit && numbers.length >= 1 && numbers.length <= 2) {
        const amount = toAmount(numbers[numbers.length - 1]);
        const lower = numbers.length === 2 ? toAmount(numbers[0]) : null;
        const thing = quantityThing(value, start, unitEnd);
        const literal = recipeLiterals(recipe, amount, unit, lower).some(
          (stems) => stems.some((stem) => thing.includes(stem)),
        );
        // Także w tekście scenariusza liczba nie może stać przy składniku.
        if (
          literal &&
          !mentionsIngredient(recipe, value, start, unitEnd, unit)
        ) {
          continue;
        }
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

/**
 * Litery innych alfabetów udające łacinę (próba .5: „Ciasto w ciепle” —
 * dwie litery cyrylicy, recenzent dał MINOR). Wyglądają tak samo, ale
 * wyszukiwanie i czytnik ekranu się na nich wykładają.
 */
const FOREIGN_SCRIPT = /[\u0370-\u03ff\u0400-\u052f\u0590-\u06ff]/u;

/**
 * Formy zależne od płci („jeśli nie obracałeś”, „sos, który zrobiłeś”) —
 * scenariusz czyta każdy, a tryb rozkazujący i bezosobowy wystarczą
 * (próby .5–w7: 5 takich tekstów na ~190 scenariuszy). Ostrzeżenie, nie
 * błąd: sama apka ma jeszcze „kupiłeś” — to decyzja Rafała.
 */
const GENDERED = /(?<![\p{L}])\p{L}+(?:łeś|łaś|łbyś|łabyś)(?![\p{L}])/giu;

function checkGendered(content: CookScenarioContent, warnings: string[]) {
  for (const [path, text] of textFields(content)) {
    const found = text.match(GENDERED);
    if (found) {
      warnings.push(
        `${path}: forma zależna od płci („${found[0]}”) — napisz trybem rozkazującym albo bezosobowo („jeśli kotlety nie są jeszcze obrócone”)`,
      );
    }
  }
}

function checkSpelling(content: CookScenarioContent, errors: string[]) {
  for (const [path, text] of textFields(content)) {
    const foreign = FOREIGN_SCRIPT.exec(text);
    if (foreign) {
      errors.push(
        `${path}: znak „${foreign[0]}” spoza polskiego alfabetu (cyrylica/greka) w „${text}” — przepisz słowo polskimi literami`,
      );
    }
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
        `${step.id}.stage: „W MIĘDZYCZASIE” bez \`during\` — krok nie dzieje się w trakcie timera; daj etykietę czynności albo null. Równoległą pracę BEZ timera (np. makaron „według opakowania”) opisz w treści: „Gdy makaron się gotuje, …”`,
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
  const rows = new Map(
    recipe.ingredients.map((row) => [row.ingredientId, row]),
  );
  for (const step of content.steps) {
    // Tylko tytuł i treść — tam zasada każe wymienić składnik.
    const words = normalizeText(`${step.title} ${step.body}`)
      .split(/[^a-z]+/)
      .filter(Boolean);
    for (const use of step.ingredients) {
      const row = rows.get(use.ingredientId);
      if (!row) continue;
      const name = row.name;
      const general =
        DEPARTMENT_WORDS[normalizeText(row.department ?? '')] ?? [];
      if (
        ingredientNamed(name, words) ||
        words.some((word) => general.some((stem) => word.startsWith(stem)))
      ) {
        continue;
      }
      warnings.push(
        `${step.id}: składnik „${name}” ma w kroku ilość, ale tytuł ani treść kroku go nie wymienia`,
      );
    }
  }
}

/**
 * Część składnika (`part`) zgodna z ilością i kolejnością (review Codexa,
 * noc 30.09) — telefon pisze przy kroku „połowa”, „reszta”, a suma ilości
 * tego nie sprawdza („połowa 200 ml” z całych 200 ml przechodziła):
 * - składnik tylko w jednym kroku = całość (`ALL`);
 * - podzielony między kroki: żadnej części `ALL`, `HALF` ≈ połowa ilości,
 *   `REST` wyłącznie przy ostatnim użyciu.
 * Słowa „połowę”, „resztę” w tekście nie wymagamy — telefon pisze je przy
 * ilości (informacja raz).
 */
function checkParts(
  recipe: WriterRecipe,
  content: CookScenarioContent,
  errors: string[],
) {
  const rows = new Map(
    recipe.ingredients.map((row) => [row.ingredientId, row]),
  );
  type Use = {
    step: CookScenarioContent['steps'][number];
    amount: number;
    part: string;
  };
  const uses = new Map<string, Use[]>();
  for (const step of content.steps) {
    for (const item of step.ingredients) {
      const list = uses.get(item.ingredientId) ?? [];
      list.push({ step, amount: item.amount, part: item.part });
      uses.set(item.ingredientId, list);
    }
  }
  for (const [id, list] of uses) {
    const row = rows.get(id);
    if (!row) continue;
    if (list.length === 1) {
      if (list[0].part !== 'ALL') {
        errors.push(
          `${list[0].step.id}: „${row.name}” trafia do dania tylko w tym kroku — part ALL (jest ${list[0].part})`,
        );
      }
      continue;
    }
    const where = list.map((use) => use.step.id).join(', ');
    list.forEach((use, index) => {
      if (use.part === 'ALL') {
        errors.push(
          `${use.step.id}: „${row.name}” jest podzielony między kroki ${where} — tu nie całość (ALL), tylko HALF, PART albo REST`,
        );
      }
      const off = Math.abs(use.amount - row.amount / 2);
      if (use.part === 'HALF' && off > Math.max(row.amount * 0.05, 0.01)) {
        errors.push(
          `${use.step.id}: „${row.name}” HALF, a to ${Math.round((use.amount / row.amount) * 100)}% ilości — połowa to HALF, inna część to PART`,
        );
      }
      if (use.part === 'REST' && index !== list.length - 1) {
        errors.push(
          `${use.step.id}: „${row.name}” REST (reszta), a składnik wraca jeszcze później (${where}) — reszta idzie przy ostatnim użyciu`,
        );
      }
    });
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
 * „o” tylko przed KRÓTKĄ nazwą („osól”, „osolonego”) — przed dłuższą łapie
 * obce słowa („oprósz” → „proszek do pieczenia”).
 */
const SHORT_PREFIXES = ['o'];

/**
 * Inne słowa na TEN SAM składnik, których rdzeń nie złapie: synonim („kmin
 * rzymski” → „kuminem”, „cannelloni” → „rurki”) i ser bez „ser” w nazwie („mozzarella” → „połową
 * sera”). Pomiar na 728 parach krok–składnik, runda 4.
 */
const ALIASES: Record<string, string[]> = {
  kmin: ['kumin'],
  cannelloni: ['rurek'],
  mozzarella: ['ser'],
  oscypek: ['ser'],
};

/**
 * Krótkie słowo rośnie o końcówkę albo o imiesłów („sól” → „osolonego”):
 * „on”/„ow” i do 3 liter końcówki.
 */
const SHORT_GROWTH = /^[a-z]{0,2}$|^(on|ow)[a-z]{0,3}$/;

/**
 * Czy któreś słowo tekstu to odmiana słowa z nazwy. Rdzeń od POCZĄTKU słowa
 * (review Codexa: „mak” w środku „do smaku” to nie mąka): 4 litery dla słów
 * dłuższych, 3 dla krótkich — a krótkie mogą urosnąć tylko o końcówkę
 * („ser” → „serem”, ale nie „serwuj”).
 */
export function ingredientNamed(name: string, words: string[]): boolean {
  const parts = significantParts(name).flatMap((part) => [
    part,
    ...(ALIASES[part] ?? []),
  ]);
  if (parts.length === 0) return true;
  return parts.some((part) => {
    const short = part.length < 5;
    const stems = stemVariants(part);
    return words.some((word) =>
      [
        word,
        ...[...VERB_PREFIXES, ...(short ? SHORT_PREFIXES : [])]
          .filter((p) => word.startsWith(p))
          .map((p) => word.slice(p.length)),
      ].some((core) =>
        stems.some(
          (stem) =>
            core.startsWith(stem) &&
            (!short || SHORT_GROWTH.test(core.slice(part.length))),
        ),
      ),
    );
  });
}

/** Po nich nazwa mówi, DO CZEGO składnik jest („przyprawa do kurczaka”), nie czym jest. */
const PURPOSE = new Set(['do', 'dla', 'na']);
/** Po nich stoi ŹRÓDŁO — też nazwa rzeczy („filet z kurczaka” → „kurczak”). */
const SOURCE = new Set(['z', 'ze']);
/**
 * Dalsze człony, które SAME nazywają składnik („ser feta” → „fetę”,
 * „cebula dymka” → „dymkę”, „makaron penne”). Zamknięta lista z katalogu
 * (review Codexa, runda 4): określenie za ogólnym rzeczownikiem („cebula
 * czerwona”, „sos pomidorowy”) nie nazywa rzeczy — „czerwona papryka” to
 * nie cebula. Po końcówce się ich nie odróżni („penne”, „mascarpone”,
 * „curry” wyglądają jak przymiotniki), więc nowy człon spoza listy da
 * najwyżej ostrzeżenie, nigdy przeoczenie. „Pestki dyni” celowo bez
 * „dyni” — to inny składnik.
 */
const NAMING_WORDS = new Set([
  // Sery
  'camembert',
  'cheddar',
  'feta',
  'gorgonzola',
  'gouda',
  'halloumi',
  'mascarpone',
  'parmezan',
  'ricotta',
  'twarog',
  // Makarony i kasze
  'cannelloni',
  'kolanka',
  'lasagne',
  'lazanki',
  'nitki',
  'orzo',
  'penne',
  'spaghetti',
  'swider',
  'tagliatelle',
  'udon',
  'kuskus',
  'manna',
  'peczak',
  // Reszta
  'barbecue',
  'chia',
  'chili',
  'curry',
  'dymka',
  'sriracha',
]);

/** Mięso i ryby tekst często nazywa ogólnie („wymieszaj mięso z ryżem”). */
const DEPARTMENT_WORDS: Record<string, string[]> = {
  mieso: ['mies'],
  ryby: ['ryb'],
};

/**
 * Człony, które NAZYWAJĄ składnik (review Codexa, rundy 3–4): człon
 * główny, źródło po „z” i słowa z `NAMING_WORDS`. Same określenia
 * („czarny”, „pszenna”, „czerwona”) nie wystarczą: „czarna fasola” to nie
 * „pieprz czarny”. Po „do / dla / na” nazwa się kończy.
 */
function significantParts(name: string): string[] {
  const words = normalizeText(name)
    .split(/[^a-z]+/)
    .filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (PURPOSE.has(word)) break;
    const head = out.length === 0 && word.length >= 3;
    const source = i > 0 && SOURCE.has(words[i - 1]) && word.length >= 3;
    const naming = i > 0 && NAMING_WORDS.has(word);
    if (head || source || naming) out.push(word);
  }
  return out;
}

/**
 * Rdzenie słowa z nazwy: 3 litery dla krótkich, 4 dla średnich, 5 dla
 * długich („przyp”, nie „przy” — to też przedrostek „przygotuj”), plus
 * oboczności: e ruchome („cukier” → „cukru”, „ocet” → „octem”) i k → c
 * („mąka” → „w mące”).
 */
function stemVariants(part: string): string[] {
  const size = part.length < 5 ? 3 : part.length < 7 ? 4 : 5;
  const variants = new Set([part]);
  const fleeting = part.replace(/i?e(?=[^aeiouy]$)/, '');
  if (fleeting !== part) variants.add(fleeting);
  for (const v of [...variants]) {
    const k = v.replace(/k(?=[aeiouy]?$)/, 'c');
    if (k !== v) variants.add(k);
  }
  return [...variants].map((v) => v.slice(0, Math.min(size, v.length)));
}

/**
 * \`startLabel\` to sam warunek startu na przycisku timera w doku („Gdy woda
 * zawrze”) — czas stoi tuż obok, więc liczba albo „odliczaj” to powtórzenie
 * (zasady .5; wcześniej „Woda wrze — odliczaj 20 min”).
 */
// Wyrażenie czasu, nie każda cyfra (review Codexa): „Śmietana 12%” jest OK.
const TIME_IN_LABEL = new RegExp(
  `${DURATION.source}|odlicz|kwadrans|sekund|minut|minuc|godzin|półtorej|(^|[^\\p{L}])(min|sek|godz)\\.?($|[^\\p{L}])`,
  'iu',
);

function checkStartLabels(
  content: CookScenarioContent,
  errors: string[],
  warnings: string[],
) {
  for (const step of content.steps) {
    const timer = step.timer;
    if (timer) {
      // EVENT czeka na zdarzenie („Gdy woda zawrze”), NOW rusza od stanu
      // („Kotlety na patelni”) — niespójność to sygnał dla recenzenta.
      const when = /^(gdy|kiedy)\b/iu.test(timer.startLabel.trim());
      if (timer.trigger === 'EVENT' && !when) {
        warnings.push(
          `${step.id}.timer: trigger EVENT, a startLabel „${timer.startLabel}” nie mówi o zdarzeniu („Gdy woda zawrze”) — może to NOW`,
        );
      }
      if (timer.trigger === 'NOW' && when) {
        warnings.push(
          `${step.id}.timer: startLabel „${timer.startLabel}” czeka na zdarzenie, a trigger NOW — może to EVENT`,
        );
      }
    }
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
 * jak ją widać: token liczby sztuk = liczba i najdłuższa forma
 * (`shownLength`).
 */
function checkAuthorLimits(content: CookScenarioContent, errors: string[]) {
  const A = COOK_AUTHOR_LIMITS;
  for (const step of content.steps) {
    if (step.title.length > A.title) {
      errors.push(
        `${step.id}.title „${step.title}”: ${step.title.length} znaków, limit ${A.title} (dwie linijki na ekranie kroku) — skróć o ${step.title.length - A.title} lub więcej, np. usuń jedno słowo`,
      );
    }
    const shown = shownLength(step.body);
    if (shown > A.body) {
      errors.push(
        `${step.id}.body: ${shown} znaków, limit ${A.body} — usuń jedno zdanie`,
      );
    }
    const label = step.timer?.startLabel;
    if (label && label.length > A.timerStartLabel) {
      errors.push(
        `${step.id}.timer.startLabel „${label}”: ${label.length} znaków, limit ${A.timerStartLabel} (przycisk timera w doku) — skróć o ${label.length - A.timerStartLabel} lub więcej`,
      );
    }
  }
}

// ── Piekarnik ───────────────────────────────────────────────────────────

const OVEN_USE = /(do piekarnika|w piekarniku|z piekarnika)(?!\s*mikrofal)/i;
const OVEN_PREHEAT = new RegExp(
  // Czasownik TUŻ przed „piekarnik” (przegląd nocny: „rozgrzej olej na
  // patelni… przełóż do piekarnika” nie jest nagrzewaniem); „włącz
  // piekarnik na 180°C” też nagrzewa, „ustaw blachę w piekarniku” — nie.
  `(nagrzej|rozgrzej|nagrzewaj)[${PL}]*\\s+piekarnik|(włącz|ustaw|nastaw)[${PL}]*\\s+piekarnik[${PL}]*\\s+(?:na|do)\\s+\\d{2,3}`,
  'iu',
);
/** Wkładanie do piekarnika — krok, który to robi, jest UŻYCIEM, nawet gdy też nagrzewa. */
const OVEN_INSERT = new RegExp(
  `(wstaw|włóż|wsuń|przełóż|umieść|piecz|zapiekaj|dopiecz)[${PL}]*\\s[^.]*(do\\s+piekarnika|w\\s+piekarniku)`,
  'iu',
);

const stepText = (step: CookScenarioContent['steps'][number]) =>
  [step.title, step.body, step.note?.text ?? ''].join(' ');

function checkOven(content: CookScenarioContent, errors: string[]) {
  const texts = content.steps.map(stepText);
  // Krok nagrzewania sam mówi „ustaw w piekarniku grill” — to nie użycie
  // (próba .5: szaszłyki odrzucone trzy razy za własny krok nagrzewania);
  // ale krok, który nagrzewa i od razu coś wkłada, jest użyciem.
  const firstUse = texts.findIndex(
    (line) =>
      OVEN_USE.test(line) &&
      (!OVEN_PREHEAT.test(line) || OVEN_INSERT.test(line)),
  );
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
  /(łoso|dorsz|mintaj|pstrąg|makrel|halibut|morszczuk|tilapi|panga|okoń|sandacz|karp|tuńczyk|ryb|sardyn|śledź|szprot)/iu;
/** Skorupiaki i głowonogi — inny sygnał niż ryba (review Codexa, noc 30.09). */
const SHELLFISH =
  /(krewet|małż|mul[eia]|kalmar|ośmiorni|homar|krab|przegrzeb|langust)/iu;

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
    label: 'owoce morza',
    ingredient: SHELLFISH,
    cue: /6[3-9]\s*°C|różowe|różowi|różowie|nieprzezroczyst|jędrn|matow|skręc|zwijają\s+się|otworzą\s+się|otworzył|otwarte/giu,
    hint: 'krewetki różowe i jędrne, nieprzezroczyste; małże otwarte',
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
      // smażonym osobno (review Codexa, E3a runda 5) — i to w kroku
      // OBRÓBKI: sygnał przy krojeniu surowego fileta użytkownik zobaczy,
      // zanim cokolwiek się upiecze (review Codexa, noc 30.09). Gdy żaden
      // krok obróbki surowca nie przywołuje — jak dotąd, dowolny krok z nim.
      const withRaw = content.steps.filter(
        (step) =>
          step.ingredients.some(
            (item) => item.ingredientId === raw.ingredientId,
          ) || step.mentions.includes(raw.ingredientId),
      );
      const cooking = withRaw.filter(
        (step) => step.phase === 'COOK' || step.phase === 'FINISH',
      );
      const where = cooking.length ? cooking : withRaw;
      const cued = where.some((step) =>
        hasAffirmativeCue(stepText(step), rule.cue),
      );
      if (!cued) {
        errors.push(
          cooking.length &&
            withRaw.some((step) => hasAffirmativeCue(stepText(step), rule.cue))
            ? `bezpieczeństwo (${rule.label}: „${raw.name}”): „po czym poznać” stoi w kroku przygotowania — przenieś je do kroku obróbki (${cooking.map((step) => step.id).join(', ')}) — ${rule.hint}`
            : `bezpieczeństwo (${rule.label}: „${raw.name}”): brak „po czym poznać” w kroku z tym składnikiem (w składnikach albo przywołaniach) — ${rule.hint}`,
        );
      }
    }
  }
}

// ── Czasy i temperatury w tekście (review Codexa, E3a runda 2) ───────────

/** Temperatury „po czym poznać” (§5.5) — wolno je pisać bez przepisu. */
const SAFETY_TEMPERATURES = new Set([63, 71, 74]);
// „200C” / „200 C” bez znaku stopnia — tak pisze dwa przepisy katalogu
// (agenci 2.10: temperatura z przepisu „nie była w przepisie”).
// „C” wrażliwe na wielkość liter („30 c” to nie temperatura), „Stopni” nie.
const TEMPERATURE = /(\d{2,3})\s*(?:°\s*C|°|[Ss]topni|STOPNI|C(?![\p{L}]))/gu;

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
 * („piecz 30 min” przy timerze 20 min). Kroki biorą czasy i temperatury
 * tylko z PIERWSZEGO wariantu przepisu; rady — z obu (drugi wariant opisuje
 * rada kucharza).
 */
function checkTextClaims(
  recipe: WriterRecipe,
  content: CookScenarioContent,
  variants: RecipeVariants,
  errors: string[],
  warnings: string[],
) {
  const recipeRanges = recipeDurationPool(variants.primary).ranges;
  const allRanges = [
    ...recipeRanges,
    ...recipeDurationPool(variants.alternative).ranges,
  ];
  const description = recipe.description ?? '';
  const stepTemperatures = new Set(
    temperaturesIn([description, ...variants.primary].join(' ')),
  );
  const tipTemperatures = new Set([
    ...stepTemperatures,
    ...temperaturesIn(variants.alternative.join(' ')),
  ]);
  const timerMax = new Map(
    content.steps.flatMap((step) =>
      step.timer ? [[step.timer.id, step.timer.maxSeconds] as const] : [],
    ),
  );

  const checkTemperatures = (
    path: string,
    text: string,
    allowed: Set<number>,
  ) => {
    for (const value of temperaturesIn(text)) {
      if (allowed.has(value) || SAFETY_TEMPERATURES.has(value)) continue;
      const other = tipTemperatures.has(value)
        ? ' — to temperatura DRUGIEGO wariantu („W piekarniku: …”); kroki prowadzą pierwszy wariant, drugi opisz jedną radą kucharza'
        : '';
      errors.push(
        `${path}: temperatury ${value}°C nie ma w przepisie (przepis: ${[...allowed].join(', ') || 'brak'}°C)${other}`,
      );
    }
  };

  const general: [string, string][] = content.tips.map((tip, i) => [
    `tips[${i}]`,
    tip,
  ]);
  if (content.nextTimeTip) general.push(['nextTimeTip', content.nextTimeTip]);
  for (const [path, text] of general) {
    checkTemperatures(path, text, tipTemperatures);
    for (const range of claimedDurations(text)) {
      // Rady mówią też o planie („obiad zajmie wtedy 25 minut”) — do czasu
      // całego scenariusza wolno; dłużej tylko czas z przepisu.
      if (
        range[1] > SHORT_SECONDS &&
        range[1] > content.totalMinutes * 60 &&
        !allRanges.some((r) => fitsRange(range, r))
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
    checkTemperatures(step.id, texts, stepTemperatures);
    // Krok nagrzewania NIE ma wyjątku (review Codexa, noc 30.09): „za
    // kwadrans” to czas spoza przepisu — nagrzewanie to estymata autora do
    // ułożenia kroków, nie tekst dla użytkownika.
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
        const other = allRanges.some((r) => fitsRange(range, r))
          ? ' — to czas DRUGIEGO wariantu („W piekarniku: …”); kroki prowadzą pierwszy wariant, drugi opisz jedną radą kucharza'
          : '';
        errors.push(
          `${step.id}: czasu ${describeRange(range)} nie ma w przepisie${other}`,
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
  alternativeRanges: [number, number][] = [],
) {
  const recipeRanges = pool.ranges;
  const timers = content.steps.flatMap((step) =>
    step.timer ? [{ step: step.id, timer: step.timer }] : [],
  );
  const fits = (timerIndex: number, range: number) => {
    const { timer } = timers[timerIndex];
    return fitsRange([timer.minSeconds, timer.maxSeconds], recipeRanges[range]);
  };
  const inGroup = new Set([
    ...pool.perSide.flatMap((g) =>
      g.combined === null ? g.singles : [...g.singles, g.combined],
    ),
    // Czas złożony: części ALBO suma — nigdy oba (recenzja 3.10: timery
    // 8100 s i 7200 s przy „2 godziny 15 minut” dawały 4 h 15 min duszenia).
    ...pool.compound.flatMap((g) => [...g.parts, g.whole]),
  ]);
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
  type Mode = 'none' | 'singles' | 'combined' | 'parts' | 'whole';
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
  const sides = pool.perSide.length;
  for (let c = 0; c < pool.compound.length; c += 1) {
    const next: Mode[][] = [];
    for (const combo of combos) {
      for (const mode of ['parts', 'whole'] as const) {
        next.push([...combo, mode]);
      }
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
    pool.compound.forEach((group, c) => {
      if (modes[sides + c] === 'parts') allowed.push(...group.parts);
      else allowed.push(group.whole);
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
    const compound = pool.compound.some((group) =>
      [...group.parts, group.whole].some((range) => fits(index, range)),
    );
    const perSide = pool.perSide.some((group) =>
      [
        ...group.singles,
        ...(group.combined === null ? [] : [group.combined]),
      ].some((range) => fits(index, range)),
    );
    const other = alternativeRanges.some((range) =>
      fitsRange([timer.minSeconds, timer.maxSeconds], range),
    )
      ? ' — to czas DRUGIEGO wariantu („W piekarniku: …”); timer prowadzi pierwszy wariant, drugi opisz jedną radą kucharza'
      : '';
    errors.push(
      !any
        ? `${step}.timer „${timer.label}” ${timer.minSeconds}–${timer.maxSeconds} s: takiego czasu nie ma w przepisie (przepis: ${
            recipeRanges.map(describeRange).join(', ') || 'brak czasów'
          })${other}`
        : perSide
          ? `timery dublują czas „z każdej strony” ${describeRange([timer.minSeconds, timer.maxSeconds])}: albo dwa odliczania po tyle, albo jedno łączne — nie oba`
          : compound
            ? `${step}.timer „${timer.label}”: timery dublują czas złożony z przepisu („2 godziny 15 minut”) — albo jeden timer na całość, albo osobne na części, nie oba`
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
    if (
      range[1] >= MIN_TIMER_SECONDS &&
      !result.owner.has(index) &&
      !pool.active.has(index) &&
      !pool.extraTurns.has(index)
    ) {
      warnings.push(`czas z przepisu ${describeRange(range)} nie ma timera`);
    }
  }
  // Czas złożony: bez ostrzeżeń o sumie; części — jak zwykłe czasy, gdy
  // wybrany wariant to części.
  pool.compound.forEach((group, c) => {
    if (result.modes[sides + c] !== 'parts') return;
    if (result.owner.has(group.whole)) return;
    for (const index of group.parts) {
      const range = recipeRanges[index];
      if (
        range[1] >= MIN_TIMER_SECONDS &&
        !result.owner.has(index) &&
        !pool.active.has(index) &&
        !pool.extraTurns.has(index)
      ) {
        warnings.push(`czas z przepisu ${describeRange(range)} nie ma timera`);
      }
    }
  });
  pool.perSide.forEach((group, g) => {
    // Aktywne smażenie „po X z każdej strony” (bez łącznego wariantu) idzie
    // bez timera — to nie sygnał.
    if (result.modes[g] !== 'none' || group.combined === null) return;
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
 * Oś czasu scenariusza w NAJGORSZYM wariancie (review Codexa): czynności
 * ręczne trwają zero, odliczania — najdłużej (`maxSeconds`), a krok bez
 * `during` rusza po NAJWCZEŚNIEJSZYM końcu timera kroku głównego przed nim
 * (kontrakt przy `CookStep.during`). W żadnej chwili nie mogą biec więcej
 * niż `MAX_PARALLEL_TIMERS` odliczania — także gdy odliczanie z „w
 * międzyczasie” trwa dłużej niż nadrzędne i zachodzi na kolejne kroki.
 */
/**
 * Nazwa timera będąca czynnością albo urządzeniem, nie rzeczą. Sama w sobie
 * jest OK (jeden timer — kontekst daje krok), błędem jest dopiero przy
 * dwóch odliczaniach naraz.
 */
const PROCESS_LABEL =
  /^(gotowanie|pieczenie|smażenie|duszenie|odpoczynek|chłodzenie|studzenie|marynowanie|marynata|czekanie|timer|gotowe|moczenie|zamrażanie|mrożenie|wyrastanie|rośnięcie|parzenie|zapiekanie|grillowanie|podgrzewanie|dogrzewanie|piekarnik|lodówka|zamrażarka|garnek|patelnia)$/iu;

function checkTimerTimeline(content: CookScenarioContent, errors: string[]) {
  let active: { id: string; end: number; label: string }[] = [];
  let now = 0;
  let waitUntil = 0;
  let waitingFor: string | null = null;
  for (const step of content.steps) {
    if (
      step.during &&
      !active.some((t) => t.id === step.during && t.end > now)
    ) {
      // Review Codexa (noc 30.09): `during` wskazywał timer, który skończył
      // się, zanim krok główny ruszył dalej — telefon grupowałby krok pod
      // nieistniejącą kapsułą.
      errors.push(
        `${step.id}.during „${step.during}”: ten timer w tym miejscu już nie biegnie (krok główny ruszył po jego alarmie) — „w międzyczasie” tylko pod trwającym odliczaniem`,
      );
    }
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
    // Dwa odliczania naraz = dwie kapsuły w doku i dwa w Dynamic Island:
    // nazwa ma mówić, CO się odlicza (próba .5: „Odpoczynek” obok
    // „Pieczenie”, 12 z 68 timerów nazwanych czynnością).
    for (const other of running) {
      const a = step.timer.label.trim().toLowerCase();
      const b = other.label.trim().toLowerCase();
      if (a === b) {
        errors.push(
          `${step.id}.timer „${step.timer.label}”: biegnie razem z timerem o tej samej nazwie (${other.id}) — nazwij je różnie, po tym, co się odlicza`,
        );
      } else {
        for (const label of [step.timer.label, other.label]) {
          if (PROCESS_LABEL.test(label.trim())) {
            errors.push(
              `${step.id}.timer: „${label}” biegnie razem z drugim odliczaniem — nazwa czynności nie mówi, który to timer; nazwij go rzeczą („Ziemniaki”, „Ciasto”, „Kasza”)`,
            );
          }
        }
      }
    }
    if (running.length + 1 > MAX_PARALLEL_TIMERS) {
      errors.push(
        `${step.id}.timer „${step.timer.label}”: w tej chwili biegną już ${running.length} odliczania (${running
          .map((t) => t.id)
          .join(
            ', ',
          )}) — najwyżej ${MAX_PARALLEL_TIMERS} naraz; przesuń krok albo połącz czynności`,
      );
    }
    active.push({
      id: step.timer.id,
      end: now + step.timer.maxSeconds,
      label: step.timer.label,
    });
    if (!step.during) {
      waitUntil = now + step.timer.minSeconds;
      waitingFor = step.timer.id;
    }
  }
}

/**
 * Najkrótszy możliwy czas całości: odliczania kroków głównych po kolei
 * (`minSeconds`), a odliczania „w międzyczasie” od startu swojego timera —
 * czynności ręczne liczone jako zero. `totalMinutes` na ekranie powitania
 * nie może obiecać mniej (review Codexa, noc 30.09: timer 60 min
 * i „5 minut” przechodziło).
 */
export function timelineFloorSeconds(content: CookScenarioContent): number {
  let now = 0;
  let waitUntil = 0;
  let finish = 0;
  for (const step of content.steps) {
    if (!step.during) {
      now = Math.max(now, waitUntil);
      waitUntil = 0;
    }
    if (!step.timer) continue;
    // Krok „w międzyczasie” dzieje się od razu po starcie kroku głównego.
    finish = Math.max(finish, now + step.timer.minSeconds);
    if (!step.during) waitUntil = now + step.timer.minSeconds;
  }
  return Math.max(finish, now, waitUntil);
}

function checkTotalMinutes(content: CookScenarioContent, errors: string[]) {
  const floor = timelineFloorSeconds(content);
  // Zaokrąglenie w dół o minutę nie jest kłamstwem.
  if (content.totalMinutes * 60 + 60 < floor) {
    errors.push(
      `totalMinutes ${content.totalMinutes}: same odliczania trwają co najmniej ${Math.ceil(floor / 60)} min — czas całości nie może być krótszy`,
    );
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
  // Jedna semantyka rodzeństwa (review Codexa, noc 1.10): pod timerem
  // najwyżej JEDNO odliczanie „w międzyczasie” (wyżej) — oś czasu liczy
  // rodzeństwo jako równoległe, bo model danych nie mówi, że drugie rusza
  // po końcu pierwszego. Dawna suma „po kolei” była martwym kodem.
}

// ── Całość ──────────────────────────────────────────────────────────────

/** Walidatory jakości treści, która już przeszła kształt i sumy. */
export function qualityChecks(
  recipe: WriterRecipe,
  content: CookScenarioContent,
): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const variants = splitRecipeVariants(recipe.instructions);
  const pool = recipeDurationPool(variants.primary);

  checkNumbersInText(recipe, content, errors);
  checkSpelling(content, errors);
  checkGendered(content, warnings);
  checkStageDuring(content, errors);
  checkStartLabels(content, errors, warnings);
  checkAuthorLimits(content, errors);
  checkIngredientsNamed(recipe, content, warnings);
  checkParts(recipe, content, errors);
  checkTitleEcho(content, warnings);
  checkOven(content, errors);
  checkSafety(recipe, content, errors);
  checkTextClaims(recipe, content, variants, errors, warnings);
  checkTimers(
    content,
    pool,
    errors,
    warnings,
    recipeDurationPool(variants.alternative).ranges,
  );
  checkTotalMinutes(content, errors);

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
  // Czas poniżej progu timera to aktywna czynność („miksuj 30–40 s”) —
  // nie czyni przepisu nietrywialnym (review Codexa, noc 30.09).
  if (
    recipeDurations(recipe.instructions).some(
      ([, to]) => to >= MIN_TIMER_SECONDS,
    )
  ) {
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
