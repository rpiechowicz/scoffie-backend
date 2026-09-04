/**
 * Ostrzeżenia o konfiguracji płatności i tożsamości zakupowej.
 *
 * Wszystkie są OSTRZEŻENIAMI, nie blokadą startu — z jednym wyjątkiem opisanym
 * niżej. Brak konfiguracji Apple znaczy „nie sprzedajemy jeszcze", a nie
 * „aplikacja ma nie wstać".
 */
export function billingEnvProblems(
  env: NodeJS.ProcessEnv,
  options: { localDatabase?: boolean } = {},
): string[] {
  const problems: string[] = [];
  const production = env.NODE_ENV === 'production';
  const has = (name: string) => Boolean((env[name] ?? '').trim());

  // Pieprz tożsamości zakupowej. Bez niego hasze są przewidywalne dla każdego,
  // kto zna nasz kod — a to one przeżywają skasowanie konta. Na bazie lokalnej
  // (dev, CI, docker-compose) nie ma czego chronić, więc cisza.
  if (!options.localDatabase && !has('PURCHASE_IDENTITY_PEPPER')) {
    problems.push(
      'PURCHASE_IDENTITY_PEPPER jest pusty — hasze tożsamości zakupowej są przewidywalne',
    );
  }

  const wantsBilling = (env.BILLING_ENABLED ?? '').trim().toLowerCase();
  const billingOn = wantsBilling === 'true' || wantsBilling === '1';
  const appleKeys = [
    'APPLE_ISSUER_ID',
    'APPLE_BILLING_KEY_ID',
    'APPLE_BILLING_PRIVATE_KEY',
  ];
  const missing = appleKeys.filter((name) => !has(name));

  if (billingOn && missing.length > 0) {
    // Świadomie NIE blokuje startu: zablokowany deploy to cała aplikacja w
    // dół, a to jest paywall, który się nie włączy. Ale musi być głośne, bo
    // inaczej wygląda jak działający paywall, który nie potwierdza zakupów.
    problems.push(
      `BILLING_ENABLED=true, ale brakuje ${missing.join(', ')} — zakupy zostają WYŁĄCZONE`,
    );
  }

  if (
    billingOn &&
    production &&
    (env.APPLE_ENVIRONMENT ?? '').trim() !== 'Production'
  ) {
    problems.push(
      'BILLING_ENABLED=true na produkcji, a APPLE_ENVIRONMENT != Production — transakcje z App Store będą odrzucane',
    );
  }

  if (
    billingOn &&
    (env.APPLE_ACCEPT_SANDBOX ?? '').trim().toLowerCase() === 'true' &&
    production
  ) {
    problems.push(
      'APPLE_ACCEPT_SANDBOX=true na produkcji — transakcja z TestFlighta daje wtedy PRO za darmo',
    );
  }

  // Ostatni hamulec przed uruchomieniem sprzedaży: dopóki `AI_TIER_OVERRIDE`
  // daje PRO wszystkim, cała ścieżka subskrypcji jest martwym kodem —
  // subskrypcje nie mają czego odblokować, a limity nie mają czego pilnować.
  if (
    billingOn &&
    (env.AI_TIER_OVERRIDE ?? '').trim().toUpperCase() === 'PRO'
  ) {
    problems.push(
      'BILLING_ENABLED=true przy AI_TIER_OVERRIDE=PRO — każdy ma PRO za darmo, subskrypcje nic nie zmieniają',
    );
  }

  return problems;
}
