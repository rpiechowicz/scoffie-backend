import { ShoppingDepartment } from '../types/shopping-department.enum';
import {
  DEPARTMENT_KEYWORD_RULES,
  CANONICAL_DEPARTMENT_OVERRIDES,
} from './shopping-classification.constants';
import {
  normalizeText,
  toTitleCase,
  toPolishDisplayText,
  keywordMatches,
} from './text-normalization.util';

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

/// Maps a raw ingredient name (potentially with parenthetical hints,
/// adjectives, or the wrong case) to a canonical Polish display name.
/// First tries an exact-match table; then a series of regex stems for
/// common cases; finally falls back to `toTitleCase(toPolishDisplayText(...))`.
export function canonicalizeIngredientName(
  name: string,
  unit?: string,
): string {
  let raw = normalizeText(name);
  const normalizedUnit = normalizeText(unit ?? '');
  if (!raw) return name.trim();

  // Strip parenthetical hints and common qualifiers.
  raw = raw.replace(/\([^)]*\)/g, ' ');
  raw = raw
    .replace(
      /\b(swieza|swiezy|swieze|suszona|suszony|suszone|mielony|mielona|mielone|surowa|surowy|niesolone|wytrawny|neutralny|koszerna|koszerny|morska|morski|wędzona|wedzona|cierpkie|cala|cały|calkowita|calkowity)\b/g,
      ' ',
    )
    .replace(/\b(filety|filet|zabki|zabek|lodygi)\b/g, ' ')
    .replace(/\b(w|we)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const exactMap: Record<string, string> = {
    'swieza pietruszka': 'pietruszka',
    'suszone liscie laurowe': 'liście laurowe',
    'liscie laurowe': 'liście laurowe',
    'świeży imbir': 'imbir',
    'swiezy imbir': 'imbir',
    'mielony imbir': 'imbir',
    'swiezy tymianek': 'tymianek',
    'suszony tymianek': 'tymianek',
    'cala kaczka': 'kaczka',
    'stek bavette': 'wołowina bavette',
    'wedzona kielbasa kielbasa lub podobna': 'kiełbasa wędzona',
    'wedzona kielbasa': 'kiełbasa wędzona',
    'tluszcz kaczy': 'tłuszcz kaczy',
    'suszona brazowa soczewica': 'soczewica brązowa',
    'surowa kapusta kiszona': 'kapusta kiszona',
    'jabłka granny smith': 'jabłka',
    'jablka granny smith': 'jabłka',
    'cierpkie jablka granny smith': 'jabłka',
    'ocet jablkowy': 'ocet jabłkowy',
    'ocet jabłkowy': 'ocet jabłkowy',
    'sok jablkowy': 'sok jabłkowy',
    'sok jabłkowy': 'sok jabłkowy',
    'ziemniaki yukon gold': 'ziemniaki',
    'zolta cebula': 'cebula',
    'czarny pieprz': 'pieprz',
    'sól koszerna': 'sól',
    'sol koszerna': 'sól',
    'sól morska': 'sól',
    'sol morska': 'sól',
    'sól morska w platkach': 'sól',
    'sol morska w platkach': 'sól',
    'proszek do pieczenia': 'proszek do pieczenia',
    'soda oczyszczona': 'soda oczyszczona',
    'jagody jalowca': 'jałowiec',
    'nasiona kminku': 'kminek',
    'koncentrat tamaryndowca': 'pasta tamaryndowa',
    'wytrawny riesling': 'riesling',
    'wywar z kurczaka': 'bulion drobiowy',
    'filety dorsza': 'dorsz',
    'filety z dorsza': 'dorsz',
    'sok z cytryny': 'sok z cytryny',
    'sok cytryny': 'sok z cytryny',
    'skorka z cytryny': 'skórka z cytryny',
    'kwaśna śmietana': 'śmietana kwaśna',
    'kwasna smietana': 'śmietana kwaśna',
    'neutralny olej': 'olej',
    'oliwa z oliwek': 'oliwa z oliwek',
    'cała kaczka': 'kaczka',
    'łodygi selera': 'seler naciowy',
    'łodyga selera': 'seler naciowy',
  };

  const mapped = exactMap[raw];
  if (mapped) return toTitleCase(mapped);

  if (/\b(kurczak|kurczak[aiemou]{0,2}|kurcz)\b/.test(raw)) return 'Kurczak';
  if (/\b(indyk|indyk[aiemou]{0,2}|indycz)\b/.test(raw)) return 'Indyk';
  if (/kaczk/.test(raw)) return 'Kaczka';
  if (/dorsz/.test(raw)) return 'Dorsz';
  if (/bavette|wołowin|wolowin/.test(raw)) return 'Wołowina bavette';
  if (/kielbas/.test(raw)) return 'Kiełbasa';
  if (/imbir/.test(raw)) {
    if (normalizedUnit === 'szt') return 'Imbir';
    if (normalizedUnit === 'g') return 'Imbir';
    return 'Imbir';
  }
  if (/tymianek/.test(raw)) {
    if (normalizedUnit === 'g') return 'Tymianek';
    return 'Tymianek';
  }
  if (/liscie laurowe/.test(raw)) return 'Liście laurowe';
  if (/kapusta kiszona/.test(raw)) return 'Kapusta kiszona';
  if (/soczewic/.test(raw)) return 'Soczewica brązowa';
  if (/ocet jablk/.test(raw)) return 'Ocet jabłkowy';
  if (/sok jablk/.test(raw)) return 'Sok jabłkowy';
  if (/jablk/.test(raw))
    return normalizedUnit === 'ml' ? 'Sok jabłkowy' : 'Jabłko';
  if (/cebul/.test(raw)) return 'Cebula';
  if (/ziemniak/.test(raw)) return 'Ziemniak';
  if (/czosn/.test(raw)) return 'Czosnek';
  if (/marchew/.test(raw)) return 'Marchew';
  if (/seler/.test(raw)) return 'Seler naciowy';
  if (/jajk/.test(raw)) return 'Jajko';
  if (/miod/.test(raw)) return 'Miód';
  if (/cukier puder/.test(raw)) return 'Cukier puder';
  if (/cukier/.test(raw)) return 'Cukier';
  if (/sok z cytryny|sok cytryny/.test(raw)) return 'Sok z cytryny';
  if (/cytryn/.test(raw)) return 'Cytryna';
  if (/kmink/.test(raw)) return 'Kminek';
  if (/jalow/.test(raw)) return 'Jałowiec';
  if (/sol/.test(raw)) return 'Sól';
  if (/pieprz/.test(raw)) return 'Pieprz';

  return toTitleCase(toPolishDisplayText(raw));
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

/// Falls back to inferring the department from the ingredient name when the
/// raw department label was empty / unmatched.
export function inferDepartmentFromName(name: string): ShoppingDepartment {
  const value = normalizeText(name);
  if (!value) return ShoppingDepartment.OTHER;
  const detected = detectDepartmentByKeywords(value);
  return detected ?? ShoppingDepartment.OTHER;
}

/// Final department resolution chain:
///   1. CANONICAL_DEPARTMENT_OVERRIDES (hand-curated, highest precedence)
///   2. Hard-coded "kielbasa => MEAT" / "imbir|tymianek|... => SPICES" rules
///   3. mapDepartmentLabel (raw label -> keyword match)
///   4. inferDepartmentFromName (name -> keyword match)
export function resolveDepartment(
  rawDepartment: string,
  ingredientName: string,
): string {
  const override =
    CANONICAL_DEPARTMENT_OVERRIDES[normalizeText(ingredientName)];
  if (override) return override;

  const normalizedName = normalizeText(ingredientName);
  if (/\bkielbas[a-z]*\b/.test(normalizedName)) return ShoppingDepartment.MEAT;
  if (
    /\b(imbir|tymianek|liscie laurowe|jalowiec|kminek)\b/.test(normalizedName)
  ) {
    return ShoppingDepartment.SPICES;
  }

  const mapped = mapDepartmentLabel(rawDepartment);
  if (mapped !== ShoppingDepartment.OTHER) return mapped;
  return inferDepartmentFromName(ingredientName);
}
