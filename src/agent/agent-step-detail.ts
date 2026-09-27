import { DayOfWeek, MealType } from '@prisma/client';
import {
  DAY_ACCUSATIVE_LABELS,
  DAY_LABELS,
  MEAL_LABELS,
} from './cards/agent-cards';
import {
  isRecipeSearchTag,
  RECIPE_TAG_LABELS,
} from '../recipes/recipe-facets.util';

/**
 * Szczegół kroku tury — JEDNA linijka faktów pod zdaniem „Dobrałem dania”
 * w arkuszu „Jak pracowałem” na telefonie (27.09.2026, Rafał: „chcę tutaj
 * serio pokazywać, co się działo, jak myślał”).
 *
 * Z wejścia narzędzia bierze to, o co model PROSIŁ (pora, dzień, życzenia —
 * tak widać jego rozumowanie), z wyniku — to, co wyszło (ile pasowało, ile
 * pokazał, czy plan się domknął, ile zmian). Czysta funkcja, bez bazy: runner
 * dopisuje wynik do kroku zaraz po wykonaniu narzędzia.
 *
 * Bez treści rozmowy i bez nazw narzędzi; nazwy dań tylko tam, gdzie krok
 * dotyczy JEDNEGO dania (przepis, odhaczenie). `null` = nic ponad zdanie.
 */
export function describeStep(
  tool: string,
  input: Record<string, unknown>,
  result:
    | { ok: true; data: unknown }
    | { ok: false; error: { code: string; message: string } },
): string | null {
  if (!result.ok) return failureDetail(result.error.code);
  const data = asRecord(result.data);

  switch (tool) {
    case 'get_week_plan': {
      const items = asArray(data.items).length;
      return items === 0
        ? 'Tydzień jest jeszcze pusty'
        : `${items} ${meals(items)} w planie tygodnia`;
    }
    case 'get_week_balance': {
      const days = asArray(data.days).filter(
        (day) => asNumber(asRecord(day).meals) > 0,
      ).length;
      return days === 0
        ? 'Brak zaplanowanych dni do policzenia'
        : `Bilans z ${days} ${daysWord(days)}`;
    }
    case 'get_recipe_details':
      return quoted(asString(data.title));
    case 'find_recipes': {
      const total = asNumber(data.total);
      return joinParts(
        [
          mealOf(input.meal_type),
          ...searchCriteria(input),
          quoted(asString(input.query)),
        ],
        total === 0 ? 'nic nie pasowało' : `${total} ${matching(total)}`,
      );
    }
    case 'search_ingredients': {
      const found = Array.isArray(result.data) ? result.data.length : 0;
      return joinParts(
        [quoted(asString(input.query))],
        found === 0 ? 'brak w bazie' : `${found} w bazie`,
      );
    }
    case 'ask_clarifying_question':
      return shorten(asString(input.question));
    case 'offer_options': {
      const offered = asNumber(data.offered);
      return joinParts(
        [asString(input.slot_label)],
        `${offered} ${dishes(offered)} do wyboru`,
      );
    }
    case 'suggest_meals': {
      const where = [mealOf(input.meal_type), dayOf(input.day_of_week)];
      if (data.exhausted === true) {
        return joinParts(where, 'pokazałem już wszystkie pasujące');
      }
      const offered = asNumber(data.offered);
      const eligible = asNumber(data.eligible);
      return joinParts(
        [...where, ...topWishes(input)],
        offered === 0
          ? 'za mało pasujących dań'
          : eligible > 0
            ? `${offered} z ${eligible} ${matching(eligible)}`
            : `${offered} ${dishes(offered)}`,
      );
    }
    case 'check_plan_conflicts': {
      const violations = asArray(data.violations).length;
      return violations === 0
        ? 'Bez konfliktów z dietą i alergenami'
        : `${violations} ${conflicts(violations)} do poprawy`;
    }
    case 'start_planning':
      return shorten(asString(input.reason));
    case 'build_meal_plan': {
      const days = asArray(input.days)
        .map((day) => DAY_LABELS[day as DayOfWeek])
        .filter(Boolean);
      // Sam zakres i wynik (27.09.2026: „pod »Ułożyłem plan« za dużo
      // zbędnego tekstu”) — pory i życzenia widać w propozycji.
      const range =
        days.length === 7
          ? 'Cały tydzień'
          : days.length > 2
            ? `${days.length} ${daysOfPlan(days.length)}`
            : days.join(', ');
      return joinParts([range], plannerOutcome(data));
    }
    case 'replace_plan_item':
      return joinParts(
        [
          mealOf(input.meal_type),
          dayOf(input.day_of_week),
          ...topWishes(input),
        ],
        plannerOutcome(data),
      );
    case 'propose_day_plan':
    case 'propose_week_plan':
    case 'propose_swap':
    case 'propose_remove_meal':
    case 'propose_household_split':
    case 'revise_proposal':
      return proposalOutcome(tool, input, data);
    case 'show_macro_gap': {
      const macro = asString(input.macro);
      const unit = macro === 'KCAL' ? 'kcal' : 'g';
      const name = MACRO_LABELS[macro] ?? '';
      const current = asNumber(data.current);
      const target = asNumber(data.target);
      return target > 0
        ? `${name}: śr. ${Math.round(current)} z ${Math.round(target)} ${unit} dziennie`
        : null;
    }
    case 'show_shopping_list': {
      const remaining = asNumber(data.remaining);
      const checked = asNumber(data.checked);
      return `${remaining} do kupienia · ${checked} ${bought(checked)}`;
    }
    case 'check_shopping_items': {
      const checked = asArray(data.checked).length;
      const missing = asArray(data.notFound).length;
      return joinParts(
        [`${checked} ${products(checked)}`],
        missing > 0 ? `${missing} bez dopasowania na liście` : null,
      );
    }
    case 'mark_meal_eaten':
      return joinParts(
        [quoted(asString(data.title))],
        data.eaten === false ? 'odznaczone' : 'zjedzone',
      );
    case 'remember_note':
      return quoted(shorten(asString(input.text)));
    case 'apply_week_plan': {
      const violations = asArray(data.violations).length;
      if (input.dry_run === true || data.dryRun === true) {
        return violations === 0
          ? 'Wszystko się zgadza'
          : `${violations} ${conflicts(violations)} do poprawy`;
      }
      const changes = asRecord(data.changes);
      return changeSummary(
        asNumber(changes.created),
        asNumber(changes.updated),
        asNumber(changes.deleted),
      );
    }
    case 'create_recipe':
    case 'update_recipe': {
      if (data.readOnly === true)
        return 'Przepis z katalogu — tylko do odczytu';
      const kcal = asNumber(data.kcalPerServing);
      return joinParts(
        [quoted(asString(data.title))],
        kcal > 0 ? `${Math.round(kcal)} kcal na porcję` : null,
      );
    }
    default:
      return null;
  }
}

/**
 * Zdanie PO kroku — w czasie przeszłym. Na żywo telefon pokazuje `label`
 * („Układam ten dzień”), a po turze arkusz czyta się jak relacja: „Ułożyłem
 * dzień”, „Sprawdziłem plan tygodnia”. Bez tego po „Ułożyłem plan” stało
 * „Układam ten dzień” — dwa czasy w jednej liście.
 */
export function doneLabel(
  tool: string,
  input: Record<string, unknown>,
): string | null {
  if (tool === 'apply_week_plan' && input.dry_run === true) {
    return 'Sprawdziłem, czy plan się spina';
  }
  return DONE_LABELS[tool] ?? null;
}

const DONE_LABELS: Record<string, string> = {
  get_household_context: 'Sprawdziłem, kto je w domu',
  get_week_plan: 'Przejrzałem plan tygodnia',
  get_week_balance: 'Policzyłem bilans tygodnia',
  get_recipe_details: 'Zajrzałem do przepisu',
  find_recipes: 'Przeszukałem przepisy',
  search_ingredients: 'Poszukałem składników',
  ask_clarifying_question: 'Dopytałem o szczegóły',
  propose_week_plan: 'Ułożyłem propozycję tygodnia',
  propose_day_plan: 'Ułożyłem propozycję dnia',
  propose_swap: 'Przygotowałem zamianę',
  revise_proposal: 'Poprawiłem propozycję',
  build_meal_plan: 'Ułożyłem plan',
  replace_plan_item: 'Dobrałem zamiennik',
  propose_remove_meal: 'Przygotowałem usunięcie',
  propose_household_split: 'Podzieliłem danie na porcje',
  offer_options: 'Wybrałem dania do wyboru',
  suggest_meals: 'Dobrałem dania do wyboru',
  check_plan_conflicts: 'Sprawdziłem dietę i alergeny',
  show_macro_gap: 'Porównałem plan z celami',
  show_shopping_list: 'Zajrzałem do listy zakupów',
  remember_note: 'Zapamiętałem to',
  mark_meal_eaten: 'Odhaczyłem posiłek',
  check_shopping_items: 'Odhaczyłem zakupy',
  start_planning: 'Przełączyłem się na dokładne planowanie',
  apply_week_plan: 'Zapisałem plan tygodnia',
  create_recipe: 'Dodałem przepis',
  update_recipe: 'Poprawiłem przepis',
  delete_recipe: 'Wycofałem przepis',
};

const MACRO_LABELS: Record<string, string> = {
  PROTEIN: 'Białko',
  FAT: 'Tłuszcz',
  CARBS: 'Węglowodany',
  KCAL: 'Kalorie',
};

const DIET_LABELS: Record<string, string> = {
  VEGETARIAN: 'wegetariańskie',
  VEGAN: 'wegańskie',
  PESCATARIAN: 'bez mięsa, z rybą',
  KETO: 'keto',
  PALEO: 'paleo',
  HIGH_PROTEIN: 'dużo białka',
};

/** Nieudane narzędzie też jest częścią przebiegu — model próbował inaczej. */
function failureDetail(code: string): string {
  switch (code) {
    case 'AI_PLAN_RANGE_EXCEEDED':
      return 'Poza zakresem tej prośby — pominąłem';
    case 'AI_ONE_CARD_PER_TURN':
      return 'Jedna karta na odpowiedź — zostałem przy pierwszej';
    case 'AI_TOOL_NOT_IN_MODE':
      return 'Niedostępne w tym trybie — poszedłem inną drogą';
    default:
      return 'Nie wyszło — spróbowałem inaczej';
  }
}

function plannerOutcome(data: Record<string, unknown>): string | null {
  const planner = asRecord(data.planner);
  const status = asString(planner.status);
  if (data.proposed === false || status === 'UNSAT') {
    return 'nie dało się dopasować dań';
  }
  const people = asArray(planner.perPersonDaily).map(asRecord);
  const me = people[0];
  const kcal = me ? Math.round(asNumber(me.avgKcal)) : 0;
  const target = me ? Math.round(asNumber(me.avgTargetKcal)) : 0;
  const kcalPart =
    kcal > 0 && target > 0 ? `śr. ${kcal} / ${target} kcal` : null;
  if (status === 'PARTIAL') {
    const filled = asString(planner.filled);
    return joinParts([filled ? `wypełnione ${filled}` : 'częściowo'], kcalPart);
  }
  return kcalPart;
}

function proposalOutcome(
  tool: string,
  input: Record<string, unknown>,
  data: Record<string, unknown>,
): string | null {
  if (data.proposed === false) {
    const violations = asArray(data.violations).length;
    return violations > 0
      ? `Odrzucone przez walidację: ${violations} ${conflicts(violations)}`
      : 'Nie powstała';
  }
  const where =
    tool === 'propose_day_plan'
      ? [dayOf(input.day_of_week, true)]
      : [mealOf(input.meal_type), dayOf(input.day_of_week)];
  const summary = asRecord(data.summary);
  const mealsCount = asNumber(summary.meals);
  const kcal = asNumber(summary.averageKcalPerDay);
  return joinParts(
    where,
    tool === 'propose_day_plan' || tool === 'propose_week_plan'
      ? joinParts(
          [mealsCount > 0 ? `${mealsCount} ${meals(mealsCount)}` : null],
          kcal > 0 ? `${kcal} kcal` : null,
        )
      : null,
  );
}

function changeSummary(created: number, updated: number, deleted: number) {
  const parts = [
    created > 0 ? `${created} ${newOnes(created)}` : null,
    updated > 0 ? `${updated} ${changed(updated)}` : null,
    deleted > 0 ? `${deleted} ${removed(deleted)}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' · ') : 'Bez zmian w planie';
}

function searchCriteria(input: Record<string, unknown>): (string | null)[] {
  const tags = asArray(input.tags)
    .filter(isRecipeSearchTag)
    .map((tag) => RECIPE_TAG_LABELS[tag].label.toLowerCase());
  const include = asArray(input.include_ingredients).map(asString);
  const exclude = asArray(input.exclude_ingredients).map(asString);
  const prep = asNumber(input.max_prep_minutes);
  const kcal = asNumber(input.max_kcal_per_serving);
  const protein = asNumber(input.min_protein_per_serving);
  return [
    ...tags,
    include.length > 0 ? `z: ${include.join(', ')}` : null,
    exclude.length > 0 ? `bez: ${exclude.join(', ')}` : null,
    prep > 0 ? `do ${prep} min` : null,
    kcal > 0 ? `do ${kcal} kcal` : null,
    protein > 0 ? `min. ${protein} g białka` : null,
  ];
}

/** Najwyżej dwa życzenia — linijka faktów, nie przepisana prośba. */
function topWishes(input: Record<string, unknown>): string[] {
  return wishes(input)
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .slice(0, 2);
}

/** Życzenia planera (`PLANNER_WISHES`) po ludzku. */
function wishes(input: Record<string, unknown>): (string | null)[] {
  const tags = [...asArray(input.must_have_tags), ...asArray(input.prefer_tags)]
    .filter(isRecipeSearchTag)
    .map((tag) => RECIPE_TAG_LABELS[tag].label.toLowerCase());
  const avoid = asArray(input.avoid_ingredients).map(asString).filter(Boolean);
  const prep = asNumber(input.max_prep_minutes);
  const kcal = asNumber(input.day_kcal_target);
  return [
    DIET_LABELS[asString(input.diet)] ?? null,
    ...[...new Set(tags)],
    avoid.length > 0 ? `bez: ${avoid.join(', ')}` : null,
    prep > 0 ? `do ${prep} min` : null,
    kcal > 0 ? `cel ${kcal} kcal` : null,
  ];
}

function mealOf(value: unknown): string | null {
  return MEAL_LABELS[value as MealType] ?? null;
}

function dayOf(value: unknown, capital = false): string | null {
  const day = value as DayOfWeek;
  if (capital) return DAY_LABELS[day] ?? null;
  const accusative = DAY_ACCUSATIVE_LABELS[day];
  return accusative ? `na ${accusative}` : null;
}

/** „A · B · C — wynik”; puste kawałki wypadają, bez wyniku bez myślnika. */
function joinParts(
  parts: readonly (string | null | undefined)[],
  outcome: string | null,
): string | null {
  const head = parts
    .filter(
      (part): part is string => typeof part === 'string' && part.trim() !== '',
    )
    .join(' · ');
  if (head && outcome) return `${head} — ${outcome}`;
  const only = head || outcome;
  if (!only) return null;
  return only.charAt(0).toUpperCase() + only.slice(1);
}

function quoted(value: string): string | null {
  return value ? `„${value}”` : null;
}

function shorten(value: string, max = 90): string {
  const text = value.trim().replace(/\s+/g, ' ');
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Odmiana po liczebniku: 1 · 2–4 (bez 12–14) · reszta. */
function plural(count: number, one: string, few: string, many: string) {
  if (count === 1) return one;
  const tens = count % 100;
  const units = count % 10;
  return units >= 2 && units <= 4 && (tens < 12 || tens > 14) ? few : many;
}

const meals = (n: number) => plural(n, 'posiłek', 'posiłki', 'posiłków');
const dishes = (n: number) => plural(n, 'danie', 'dania', 'dań');
const daysWord = (n: number) => plural(n, 'dnia', 'dni', 'dni');
const daysOfPlan = (n: number) => plural(n, 'dzień', 'dni', 'dni');
const matching = (n: number) => plural(n, 'pasujące', 'pasujące', 'pasujących');
const conflicts = (n: number) => plural(n, 'uwaga', 'uwagi', 'uwag');
const bought = (n: number) => plural(n, 'kupiony', 'kupione', 'kupionych');
const products = (n: number) =>
  plural(n, 'produkt odhaczony', 'produkty odhaczone', 'produktów odhaczonych');
const newOnes = (n: number) => plural(n, 'nowy', 'nowe', 'nowych');
const changed = (n: number) =>
  plural(n, 'zmieniony', 'zmienione', 'zmienionych');
const removed = (n: number) => plural(n, 'usunięty', 'usunięte', 'usuniętych');
