import { normalizeProductKey } from './text-normalization.util';
import { toShoppingUnit } from './shopping-items.util';

/**
 * Reguły pozycji dopisanych RĘCZNIE (`ShoppingListManualItem`) — czyste
 * funkcje, z których korzysta zapis, przeliczanie listy i stan dla telefonu.
 * Jedna definicja klucza i przyklejania, bo te trzy miejsca muszą się
 * zgadzać co do tego, w którym wierszu listy stoi dopisane.
 */

/** Jednostki, w których telefon podaje ilość; `kg` i `l` przeliczamy na `g`/`ml`. */
export const SHOPPING_PRODUCT_INPUT_UNITS = [
  'szt',
  'g',
  'kg',
  'ml',
  'l',
] as const;
export type ShoppingProductInputUnit =
  (typeof SHOPPING_PRODUCT_INPUT_UNITS)[number];

/** Sufit ilości w jednostce, w której przyszła — chroni listę przed literówką „10000 szt”. */
export const SHOPPING_PRODUCT_INPUT_LIMITS: Record<
  ShoppingProductInputUnit,
  number
> = { szt: 99, g: 20_000, kg: 20, ml: 20_000, l: 20 };

/** Sufit SUMY w jednostce listy — kolejne dopisania nie urosną ponad niego. */
export const SHOPPING_MANUAL_LIST_LIMITS: Record<string, number> = {
  szt: 99,
  g: 20_000,
  ml: 20_000,
};

/** Najdłuższa nazwa własnego produktu. */
export const SHOPPING_PRODUCT_NAME_MAX = 60;

export type ManualAmount = { amount: number; unit: string } | null;

/**
 * Nazwa z klawiatury: bez znaków sterujących, białe znaki zwinięte.
 * Pusty wynik = nazwy nie ma.
 */
/** Znaki sterujące i niewidoczne (zero-width, kierunek pisma, BOM). */
function isInvisible(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x206f) ||
    code === 0xfeff
  );
}

export function cleanProductName(raw: string): string {
  let visible = '';
  for (const char of raw) {
    visible += isInvisible(char.codePointAt(0) ?? 0) ? ' ' : char;
  }
  return visible.replace(/\s+/g, ' ').trim();
}

/**
 * Klucz produktu w tabeli dopisanych — ta sama postać co część nazwy
 * w `productKey` (`normalizeProductKey`: małe litery, z ogonkami), więc
 * „mleko” dopisane trafia w wiersz „mleko::ml” z planu.
 */
export function manualNameKey(name: string): string {
  return cleanProductName(name).toLowerCase();
}

/** Nazwa z klucza listy: `mleko::ml` → `mleko`. */
export function productKeyNamePart(productKey: string): string {
  const separator = productKey.lastIndexOf('::');
  return (separator >= 0 ? productKey.slice(0, separator) : productKey)
    .trim()
    .toLowerCase();
}

/**
 * Ilość z telefonu w jednostce listy: `kg`→`g`, `l`→`ml`, a gramy produktu
 * ze znaną masą sztuki — na sztuki, jak w planie (`toShoppingUnit`). Bez tego
 * dopisane „500 g cebuli” stanęłoby obok „cebula 2 szt” z planu.
 */
export function toManualListUnit(
  amount: number,
  unit: string,
  gramsPerPiece: number | null | undefined,
): { amount: number; unit: string } {
  let base = { amount, unit };
  if (unit === 'kg') base = { amount: amount * 1000, unit: 'g' };
  if (unit === 'l') base = { amount: amount * 1000, unit: 'ml' };
  const shopping = toShoppingUnit(base.amount, base.unit, gramsPerPiece);
  return { amount: Number(shopping.amount.toFixed(3)), unit: shopping.unit };
}

/**
 * Ponowne dopisanie tego samego produktu w tym samym tygodniu.
 *
 * - bez ilości → zostaje to, co było („kup mleko” niczego nie odejmuje);
 * - wcześniej bez ilości → bierze nową;
 * - ta sama jednostka → suma (do sufitu jednostki);
 * - inna jednostka → nowa wygrywa. Sumowanie sztuk z gramami nie ma sensu,
 *   a telefon i tak podaje ilość w jednostce, którą produkt ma na liście.
 */
export function mergeManualAmount(
  existing: ManualAmount,
  next: ManualAmount,
): ManualAmount {
  if (!next) return existing;
  if (!existing || existing.unit !== next.unit) return next;
  const limit = SHOPPING_MANUAL_LIST_LIMITS[next.unit] ?? Infinity;
  return {
    amount: Math.min(Number((existing.amount + next.amount).toFixed(3)), limit),
    unit: next.unit,
  };
}

/**
 * Wiersz listy, w którym stoi dopisana pozycja.
 *
 * Z ilością — własny klucz `nazwa::jednostka` (sumuje się z planem w tej
 * samej jednostce). Bez ilości — przykleja się do wiersza tego produktu,
 * który lista już ma; przy kilku jednostkach do pierwszego alfabetycznie,
 * żeby przeliczenie listy i stan dla telefonu zawsze wskazały ten sam.
 * Gdy lista produktu nie ma — własny wiersz z pustą jednostką.
 */
export function manualRowKey(
  row: { nameKey: string; amount: number | null; unit: string | null },
  existingKeys: Iterable<string>,
): string {
  if (row.amount != null && row.unit) {
    return normalizeProductKey(row.nameKey, row.unit);
  }
  let attached: string | null = null;
  for (const key of existingKeys) {
    if (productKeyNamePart(key) !== row.nameKey) continue;
    if (attached === null || key < attached) attached = key;
  }
  return attached ?? normalizeProductKey(row.nameKey, '');
}
