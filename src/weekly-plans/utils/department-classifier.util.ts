import { ShoppingDepartment } from '../types/shopping-department.enum';
import { DEPARTMENT_KEYWORD_RULES } from './shopping-classification.constants';
import { normalizeText, keywordMatches } from './text-normalization.util';

const SHOPPING_DEPARTMENT_VALUES = new Set<string>(
  Object.values(ShoppingDepartment),
);
const DEPARTMENTS_LONGEST_FIRST = [...Object.values(ShoppingDepartment)].sort(
  (a, b) => b.length - a.length,
);

/// Walks DEPARTMENT_KEYWORD_RULES until one of the rule's keywords matches
/// (as a stem). Returns null if no rule matched.
export function detectDepartmentByKeywords(
  text: string,
): ShoppingDepartment | null {
  if (!text) return null;
  for (const rule of DEPARTMENT_KEYWORD_RULES) {
    if (rule.keywords.some((keyword) => keywordMatches(text, keyword))) {
      return rule.department;
    }
  }
  return null;
}

/// Tries to map a raw `Ingredient.department` string (set in the catalog)
/// into a real ShoppingDepartment via keyword matching. Returns OTHER if
/// nothing matches.
export function mapDepartmentLabel(
  rawDepartment?: string | null,
): ShoppingDepartment {
  const value = normalizeText(rawDepartment ?? '');
  if (!value) return ShoppingDepartment.OTHER;
  const detected = detectDepartmentByKeywords(value);
  return detected ?? ShoppingDepartment.OTHER;
}

/// Dział na liście zakupów bierze się WPROST z `RecipeIngredient.department`,
/// czyli z `Ingredient.category` katalogu — te etykiety są bajt w bajt
/// identyczne z wartościami `ShoppingDepartment` (import i `RecipesService.create`
/// kopiują kategorię składnika). Dopasowanie po słowach kluczowych zostaje
/// tylko jako siatka pod stare etykiety spoza enumu („Nabiał i jajko”).
///
/// Dawniej nazwa składnika przechodziła jeszcze przez regexowy
/// „canonicalizer” (`/sol/` → „Sól”), który przemianowywał fasolę na sól
/// i scalał kawałki kurczaka w jeden wiersz. Nazwa z katalogu jest już
/// kanoniczna, więc lista używa jej dosłownie.
export function toShoppingDepartment(
  rawDepartment?: string | null,
): string {
  const trimmed = (rawDepartment ?? '').trim();
  if (!trimmed) return ShoppingDepartment.OTHER;
  if (SHOPPING_DEPARTMENT_VALUES.has(trimmed)) return trimmed;

  // Stare, dłuższe etykiety („Ryby i owoce morza”, „Nabiał i jajko”)
  // zaczynają się od nazwy działu — to pewniejsze niż słowa kluczowe, które
  // w „Ryby i owoce morza” łapią najpierw „owoce”.
  const normalized = normalizeText(trimmed);
  const byPrefix = DEPARTMENTS_LONGEST_FIRST.find(
    (department) =>
      department !== ShoppingDepartment.OTHER &&
      normalized.startsWith(normalizeText(department)),
  );
  if (byPrefix) return byPrefix;

  return mapDepartmentLabel(trimmed);
}
