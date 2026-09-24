import type { Prisma } from '@prisma/client';
import { isMealType, MEAL_TYPES_IN_DAY_ORDER } from '../../common/meal-types';
import type { HouseholdListItem, MealType } from '../contract';

/** Doba ma 1440 minut — ta sama granica, co w `UpdateHouseholdMealTimesDto`. */
const MINUTES_IN_DAY = 24 * 60;

/**
 * `Household.mealSlotTimes` (Json) → mapa z kontraktu.
 *
 * Kolumna jest walidowana przy ZAPISIE (`MealSlotTimesConstraint`), ale panel
 * czyta też wiersze sprzed tej walidacji i wszystko, co ktoś wpisał ręcznie.
 * Wpis, który nie jest porą z enuma z całą minutą doby, odpada po cichu —
 * panel ma się otworzyć, a nie paść na jednym śmieciu. `null` zostaje
 * `null`em (dom nie ruszał godzin), a pusta mapa pustą mapą (to co innego:
 * „żadna pora nie ma stałej godziny").
 */
export function parseMealSlotTimes(
  raw: Prisma.JsonValue | null,
): Partial<Record<MealType, number>> | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const times: Partial<Record<MealType, number>> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (
      isMealType(key) &&
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= 0 &&
      value < MINUTES_IN_DAY
    ) {
      times[key] = value;
    }
  }
  return times;
}

/** Pory w kolejności dnia (enum), bez duplikatów. */
export function orderMealTypes(types: readonly MealType[]): MealType[] {
  const present = new Set(types);
  return MEAL_TYPES_IN_DAY_ORDER.filter((type) => present.has(type));
}

/**
 * `CookidooIntegration.status` to tekst, nie enum. Domena traktuje wszystko
 * poza `CONNECTED` jak niedziałające połączenie (`status !== CONNECTED` w
 * `CookidooIntegrationService`) — panel mówi to samo, zamiast przepuszczać
 * wartość spoza kontraktu.
 */
export function cookidooStatus(
  status: string | null | undefined,
): HouseholdListItem['cookidoo'] {
  if (status === undefined || status === null) return null;
  return status === 'CONNECTED' ? 'CONNECTED' : 'AUTH_FAILED';
}

/** Najpóźniejsza data z listy (np. `lastLoginAt` domowników). */
export function latest(dates: readonly (Date | null)[]): Date | null {
  let best: Date | null = null;
  for (const date of dates) {
    if (date && (!best || date.getTime() > best.getTime())) best = date;
  }
  return best;
}
