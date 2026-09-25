/**
 * Nadpisania zmiennych środowiskowych z panelu (`RuntimeSetting`, ROADMAPA
 * §5.12) — pamięć procesu, którą wypełnia `RuntimeSettingsService`.
 *
 * Moduł bez zależności, a nie pole serwisu: `readAgentEnv()` wołają dziesiątki
 * miejsc bez wstrzykiwania (retencja, propozycje, liczniki, konta), a
 * wyłącznik asystenta ma działać we WSZYSTKICH naraz. Odczyt jest synchroniczny
 * — baza nie leży na ścieżce żądania, serwis odświeża tę mapę co 30 s i od razu
 * po każdym zapisie z panelu.
 *
 * Do mapy trafiają wyłącznie klucze z białej listy (`RUNTIME_SETTING_KEYS`)
 * z wartością, która przeszła walidację — pilnuje tego serwis.
 */
let overrides: Readonly<Record<string, string>> = Object.freeze({});

export function runtimeOverrides(): Readonly<Record<string, string>> {
  return overrides;
}

export function setRuntimeOverrides(next: Record<string, string>): void {
  overrides = Object.freeze({ ...next });
}

/** `process.env` z nałożonymi nadpisaniami (nadpisanie wygrywa). */
export function effectiveProcessEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const current = overrides;
  if (Object.keys(current).length === 0) return env;
  return { ...env, ...current };
}
