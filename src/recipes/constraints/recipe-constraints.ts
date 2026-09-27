import { DietPreferenceValue, MealType } from '@prisma/client';
import {
  conflictingAllergens,
  NutritionPerServing,
  satisfiesDiet,
} from '../diet-rules.util';
import { ingredientMatches, queryStems } from '../ingredient-match.util';

/**
 * Jedna definicja DOPUSZCZALNOŚCI przepisu (N8A, `ConstraintSet v1`).
 *
 * Do 27.09.2026 ta sama reguła domenowa miała trzy implementacje: planer
 * (`hardFilterReason`), walidator zapisu planu (`collectPlanViolations`) i
 * wyszukiwarkę asystenta (`passesAudience`). Rozjazd między nimi to realne
 * błędy (karta ≠ bilans, N5-1), a każde nowe ograniczenie trzeba było
 * dopisywać trzy razy. Tu żyją reguły; silniki tylko budują zbiór i czytają
 * werdykt.
 *
 * Zakres v1 = semantyka planera z 27.09.2026 (test równoważności z zamrożoną
 * kopią starego kodu: `constraint-engine.equivalence.spec.ts`) z jedną
 * świadomą zmianą: „bez X” po rdzeniu słowa, jak wyszukiwarka (S6).
 * Różnice między silnikami, które zostają (pora z bazowym `mealType`
 * w zapisie, dieta w zapisie, tagi ORAZ vs grupy) — patrz testy charakteryzujące
 * (`constraint-semantics.characterization.spec.ts`); każda to osobna decyzja.
 *
 * Moduł leży w `recipes/`, a nie w `meal-planner/`: planer importuje utile
 * `weekly-plans/`, więc walidator zapisu sięgający do planera zrobiłby cykl.
 * Czyste funkcje, zero zapytań, zero efektów.
 */

export const CONSTRAINT_SET_VERSION = 1 as const;

/**
 * Powód odrzucenia — jeden słownik dla wszystkich silników. Kolejność
 * sprawdzania (a więc to, który powód wygrywa przy kilku naraz) jest częścią
 * kontraktu: diagnostyka planera liczy „pierwszy powód na przepis”.
 */
export type ConstraintReason =
  | 'INACTIVE'
  | 'MEAL_TYPE'
  | 'EXCLUDED_RECIPE'
  | 'PREP_TIME'
  | 'ALLERGEN'
  | 'EXCLUDED_INGREDIENT'
  | 'DIET'
  | 'REQUEST_DIET'
  | 'REQUIRED_TAG'
  | 'AVOIDED_INGREDIENT'
  | 'NO_NUTRITION';

/** Powody wynikające z tego, KTO je (a nie z prośby). */
export type AudienceReason = Extract<
  ConstraintReason,
  'ALLERGEN' | 'EXCLUDED_INGREDIENT' | 'DIET'
>;

/**
 * Ograniczenia audytorium — SUMA po osobach, które jedzą. Dane o zdrowiu:
 * zbiór nie trafia do promptu ani do logów.
 */
export type AudienceConstraints = {
  allergens: readonly string[];
  excludedIngredientIds: readonly string[];
  /** Diety profili; `NONE` niczego nie zawęża (można je pominąć albo zostawić). */
  diets: readonly DietPreferenceValue[];
};

/** Wymagania PROŚBY — twarde, poza profilami jedzących. */
export type RequestConstraints = {
  /** Pora slotu; `null` = bez sprawdzania pory (np. wyszukiwarka bez pory). */
  mealType: MealType | null;
  excludeRecipeIds: readonly string[];
  /** Twardy limit czasu (min); `null` = bez limitu. */
  maxPrepMinutes: number | null;
  /** Dieta tej prośby („wegetariańska kolacja”); `null` = bez dodatkowej. */
  requestDiet: DietPreferenceValue | null;
  /** Tagi, które danie musi mieć — WSZYSTKIE (semantyka planera). */
  requiredTags: readonly string[];
  /**
   * Składniki, których danie nie może mieć — po RDZENIU słowa, jak
   * wyszukiwarka (`ingredientMatches`): „jajka” trafia „jajko”, „orzechy” —
   * „orzech włoski”, „ser” — nie trafia „ogórka konserwowego”. Do 28.09.2026
   * planer brał podciąg i „bez jajek” nie wykluczało ani jednego z 160 dań
   * z jajkiem (N8A S6, raport M11).
   */
  avoidIngredients: readonly string[];
  /** Bez makr na porcję przepis odpada (planer nie policzy celu). */
  requireNutrition: boolean;
};

/** Wersjonowany, serializowalny opis ograniczeń jednej prośby dla jednego audytorium. */
export type ConstraintSetV1 = {
  v: typeof CONSTRAINT_SET_VERSION;
  audience: AudienceConstraints;
  request: RequestConstraints;
};

/** Minimum o przepisie potrzebne regułom audytorium. */
export type AudienceSubject = {
  allergens: readonly string[];
  /** Wszystkie składniki; pusta lista = brak danych o składnikach (diety przepuszczają). */
  ingredientIds: readonly string[];
  dietTags: readonly string[];
  perServing: NutritionPerServing | null;
};

/** Przepis w kształcie, którego potrzebują wszystkie reguły. */
export type ConstraintSubject = AudienceSubject & {
  id: string;
  active: boolean;
  /** Pory, do których przepis się nadaje. */
  slots: readonly MealType[];
  prepTimeMinutes: number;
  /** Nazwy składników znormalizowane (ASCII, małe litery). */
  ingredientNames: readonly string[];
  tags: readonly string[];
};

/** Kto je — minimum profilu potrzebne do sumy audytorium. */
export type AudienceMember = {
  allergens: readonly string[];
  excludedIngredientIds: readonly string[];
  diet: DietPreferenceValue;
};

/** Suma ograniczeń osób, które jedzą (kolejność pierwszego wystąpienia, bez powtórek). */
export function audienceConstraintsOf(
  members: readonly AudienceMember[],
): AudienceConstraints {
  return {
    allergens: unique(members.flatMap((member) => member.allergens)),
    excludedIngredientIds: unique(
      members.flatMap((member) => member.excludedIngredientIds),
    ),
    diets: unique(members.map((member) => member.diet)),
  };
}

/** Alergeny przepisu, których unika audytorium (posortowane; puste = bezpieczny). */
export function allergenConflicts(
  subject: Pick<AudienceSubject, 'allergens'>,
  audience: Pick<AudienceConstraints, 'allergens'>,
): string[] {
  return conflictingAllergens(subject.allergens, audience.allergens);
}

/** Składniki przepisu wykluczone przez kogoś z jedzących (kolejność przepisu). */
export function excludedIngredientHits(
  subject: Pick<AudienceSubject, 'ingredientIds'>,
  audience: Pick<AudienceConstraints, 'excludedIngredientIds'>,
): string[] {
  if (audience.excludedIngredientIds.length === 0) return [];
  const excluded = new Set(audience.excludedIngredientIds);
  return subject.ingredientIds.filter((id) => excluded.has(id));
}

/**
 * Słowa-KATEGORIE w „bez X” (N8A S6, M12): składniki w katalogu to gatunki
 * (łosoś, dorsz, schab), więc „bez ryby” po nazwie nie trafiało niczego.
 * Kategoria idzie po tagu diety przepisu — tym samym, który napędza diety
 * (`satisfiesDiet`). Klucz = początek rdzenia słowa po normalizacji
 * („ryby”, „rybę”, „rybnego” → `ryb`; „mięsa” → `mies`). Świadomie bez
 * „drobiu” (MEAT to też wołowina) i „owoców morza” (tagi nie rozróżniają
 * mięczaków) — tam zostaje dopasowanie po nazwie.
 */
const AVOIDED_CATEGORY_TAGS: readonly { root: string; tag: string }[] = [
  { root: 'ryb', tag: 'FISH' },
  { root: 'mies', tag: 'MEAT' },
  { root: 'nabia', tag: 'DAIRY' },
  { root: 'skorup', tag: 'CRUSTACEAN' },
];

/**
 * Czy przepis ma składnik z prośby: po rdzeniu słowa (`ingredientMatches`)
 * albo jako kategorię po tagu diety („ryba” → FISH). Jedna reguła dla „bez X”
 * (planer `checkRecipe`, `exclude_ingredients`) i „z X” (`suggest_meals`,
 * `include_ingredients`) — inaczej „co na kolację z rybą?” nie znajdowało
 * żadnego z 30 dań rybnych.
 */
export function mentionsIngredient(
  subject: { ingredientNames: readonly string[]; dietTags: readonly string[] },
  phrase: string,
): boolean {
  if (subject.ingredientNames.some((name) => ingredientMatches(name, phrase))) {
    return true;
  }
  const stems = queryStems(phrase);
  return AVOIDED_CATEGORY_TAGS.some(
    ({ root, tag }) =>
      subject.dietTags.includes(tag) &&
      stems.some((stem) => stem.startsWith(root)),
  );
}

/** Czy przepis spełnia dietę (asymetria jak w iOS — patrz `satisfiesDiet`). */
export function subjectSatisfiesDiet(
  subject: AudienceSubject,
  diet: DietPreferenceValue,
): boolean {
  return satisfiesDiet(diet, {
    dietTags: subject.dietTags,
    hasIngredientData: subject.ingredientIds.length > 0,
    perServing: subject.perServing,
  });
}

/**
 * Pierwszy powód z reguł AUDYTORIUM (alergen → wykluczenie → dieta profilu);
 * `null` = każdy z jedzących może to zjeść.
 */
export function audienceReason(
  subject: AudienceSubject,
  audience: AudienceConstraints,
): AudienceReason | null {
  if (allergenConflicts(subject, audience).length > 0) return 'ALLERGEN';
  if (excludedIngredientHits(subject, audience).length > 0) {
    return 'EXCLUDED_INGREDIENT';
  }
  if (!audience.diets.every((diet) => subjectSatisfiesDiet(subject, diet))) {
    return 'DIET';
  }
  return null;
}

/**
 * Pierwszy powód, dla którego przepis NIE może stanąć przy tych
 * ograniczeniach; `null` = może. Kolejność: aktywność, pora, wykluczony
 * przepis, czas, audytorium, dieta prośby, tagi, „bez X”, makra.
 */
export function checkRecipe(
  subject: ConstraintSubject,
  set: ConstraintSetV1,
): ConstraintReason | null {
  const { request } = set;
  if (!subject.active) return 'INACTIVE';
  if (request.mealType !== null && !subject.slots.includes(request.mealType)) {
    return 'MEAL_TYPE';
  }
  if (request.excludeRecipeIds.includes(subject.id)) return 'EXCLUDED_RECIPE';
  if (
    request.maxPrepMinutes !== null &&
    subject.prepTimeMinutes > request.maxPrepMinutes
  ) {
    return 'PREP_TIME';
  }
  const byAudience = audienceReason(subject, set.audience);
  if (byAudience) return byAudience;
  if (
    request.requestDiet !== null &&
    !subjectSatisfiesDiet(subject, request.requestDiet)
  ) {
    return 'REQUEST_DIET';
  }
  if (!request.requiredTags.every((tag) => subject.tags.includes(tag))) {
    return 'REQUIRED_TAG';
  }
  if (
    request.avoidIngredients.some((avoided) =>
      mentionsIngredient(subject, avoided),
    )
  ) {
    return 'AVOIDED_INGREDIENT';
  }
  // Na końcu: bez makr nie da się policzyć celu, ale to nie jest zakaz dla
  // ręcznego wyboru — dlatego wymaganie włącza prośba, nie przepis.
  if (request.requireNutrition && !subject.perServing) return 'NO_NUTRITION';
  return null;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
