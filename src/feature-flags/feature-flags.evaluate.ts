import { createHash } from 'crypto';

/** Klucz flagi: `assistant.voice`, `plan_v2` — małe litery, cyfry, `.`, `_`, `-`. */
export const FEATURE_FLAG_KEY_PATTERN = /^[a-z][a-z0-9._-]{1,63}$/;

export type FlagDefinition = {
  key: string;
  enabled: boolean;
  /** 0–100 */
  rolloutPercent: number;
};

/** Skąd wzięła się wartość flagi dla domu (panel pokazuje to przy przełączniku). */
export type FlagSource = 'override' | 'rollout' | 'global' | 'off';

/**
 * Kubełek domu dla flagi: 0–99, deterministyczny i stabilny (ten sam dom
 * i klucz → zawsze ten sam kubełek, także po restarcie i na innej instancji).
 * Klucz flagi jest w haszu, żeby każda beta losowała INNE domy — inaczej
 * te same 10 % dostawałoby wszystkie eksperymenty naraz. Podniesienie
 * odsetka tylko dokłada domy (kubełek < procent), nikogo nie zabiera.
 */
export function rolloutBucket(flagKey: string, householdId: string): number {
  const digest = createHash('sha256')
    .update(`${flagKey}:${householdId.toLowerCase()}`)
    .digest();
  return digest.readUInt32BE(0) % 100;
}

/**
 * Ocena jednej flagi. Kolejność: nadpisanie domu > rollout > globalne.
 * Nadpisanie działa w obie strony (dom może mieć betę wyłączoną mimo
 * `enabled`); dom bez nadpisania dostaje flagę, gdy wpada w rollout albo
 * gdy flaga jest włączona dla wszystkich. Bez domu liczy się tylko `enabled`.
 */
export function evaluateFlag(
  flag: FlagDefinition,
  householdId: string | null,
  override: boolean | undefined,
): { value: boolean; source: FlagSource } {
  if (householdId && override !== undefined) {
    return { value: override, source: 'override' };
  }
  if (
    householdId &&
    flag.rolloutPercent > 0 &&
    rolloutBucket(flag.key, householdId) < flag.rolloutPercent
  ) {
    return { value: true, source: 'rollout' };
  }
  if (flag.enabled) return { value: true, source: 'global' };
  return { value: false, source: 'off' };
}

/** Wszystkie flagi domu jako `{ klucz: bool }` (kolejność kluczy alfabetyczna). */
export function evaluateFlags(
  flags: readonly FlagDefinition[],
  householdId: string | null,
  overrides: ReadonlyMap<string, boolean> | undefined,
): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const flag of [...flags].sort((a, b) => a.key.localeCompare(b.key))) {
    result[flag.key] = evaluateFlag(
      flag,
      householdId,
      overrides?.get(flag.key),
    ).value;
  }
  return result;
}
