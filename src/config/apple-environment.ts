/**
 * Środowisko App Store: „Production" albo „Sandbox".
 *
 * DLACZEGO OSOBNY PLIK, A NIE POLE W `billing-env.ts`. Odpowiedź na pytanie
 * „czy ta subskrypcja w ogóle się liczy" potrzebna jest w DWÓCH miejscach:
 * w bramce zakupu (moduł płatności) i w `subscriptionAlive`, czyli tam, gdzie
 * liczy się dostęp. Gdyby mieszkała tylko w płatnościach, wiersz zapisany przy
 * złej konfiguracji dawałby PRO w nieskończoność, bo nikt by go już nie pytał
 * o środowisko — dokładnie ta luka, którą zamyka `acceptedTransactionEnvironments`.
 *
 * LITERÓWKA MA BYĆ SŁYSZALNA. Poprzednia wersja robiła
 * `APPLE_ENVIRONMENT === 'Production' ? 'Production' : 'Sandbox'`, więc
 * `production` (małą literą) albo `Prodution` po cichu przestawiały produkcję
 * w tryb testowy: testerzy dostawali darmowe PRO, a płacący klienci
 * `BILLING_TRANSACTION_UNKNOWN`, bo pytanie o stan szło pod adres sandboxa.
 * Teraz wielkość liter nie ma znaczenia, a napis, którego nie da się rozpoznać,
 * zgłasza się przy starcie (`billingEnvProblems`).
 */

export type AppleEnvironment = 'Production' | 'Sandbox';

/** Domyślne środowisko: brak zmiennej znaczy „nie sprzedajemy jeszcze". */
export const DEFAULT_APPLE_ENVIRONMENT: AppleEnvironment = 'Sandbox';

/**
 * Napis → środowisko. `null` = napis niepusty, którego nie rozpoznajemy;
 * wołający decyduje, czy to ostrzeżenie (start), czy wartość domyślna (odczyt).
 */
export function parseAppleEnvironment(
  raw: string | undefined | null,
): AppleEnvironment | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return DEFAULT_APPLE_ENVIRONMENT;
  if (value === 'production' || value === 'prod') return 'Production';
  if (value === 'sandbox' || value === 'test') return 'Sandbox';
  return null;
}

/** Środowisko z env; napis nierozpoznany schodzi do sandboxa i jest zgłaszany. */
export function readAppleEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): AppleEnvironment {
  return (
    parseAppleEnvironment(env.APPLE_ENVIRONMENT) ?? DEFAULT_APPLE_ENVIRONMENT
  );
}

/** Czy dopuszczamy transakcje z sandboxa przy tym środowisku. */
export function readAcceptSandbox(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.APPLE_ACCEPT_SANDBOX?.trim().toLowerCase();
  if (raw === undefined || raw === '') {
    // Poza produkcją domyślnie tak — inaczej nie da się niczego przetestować.
    return readAppleEnvironment(env) !== 'Production';
  }
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/**
 * Środowiska, których transakcje uznajemy TERAZ.
 *
 * Używa tego i bramka zakupu, i `subscriptionAlive`. Dzięki temu wiersz
 * zapisany w czasie, gdy konfiguracja mówiła „Sandbox", przestaje dawać PRO w
 * tej samej sekundzie, w której konfiguracja zostaje poprawiona — bez migracji
 * i bez ręcznego sprzątania bazy.
 */
export function acceptedTransactionEnvironments(
  env: NodeJS.ProcessEnv = process.env,
): AppleEnvironment[] {
  const environment = readAppleEnvironment(env);
  return readAcceptSandbox(env) && environment !== 'Sandbox'
    ? [environment, 'Sandbox']
    : [environment];
}
