/**
 * Jedna definicja klamry porcji dla wszystkich miejsc, które liczą
 * `plannedServings`: serwisu planu (upsert slotu) i hooków składu gospodarstwa
 * (`plan-roster.util.ts`). Gdyby te dwie reguły się rozjechały, hook
 * „naprawiałby" wartości, których serwis nigdy by nie zapisał — albo
 * odwrotnie, przegapiał te, które zapisał.
 */
export const PLANNED_SERVINGS_MIN = 1;
export const PLANNED_SERVINGS_MAX = 12;

export function clampPlannedServings(value: number): number {
  return Math.min(
    PLANNED_SERVINGS_MAX,
    Math.max(PLANNED_SERVINGS_MIN, Math.trunc(value)),
  );
}

/**
 * Reguła auto: tyle porcji, ile osób je danie. Imienny zbiór uczestników
 * liczy się z długości listy, „Wspólne" (pusty zbiór) — z liczby domowników.
 */
export function autoPlannedServings(
  participantCount: number,
  memberCount: number,
): number {
  return clampPlannedServings(
    participantCount > 0 ? participantCount : memberCount,
  );
}
