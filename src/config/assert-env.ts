import { parseEncryptionKey } from '../common/crypto.util';
import { throttleEnvProblems } from '../common/throttle/throttle-env';
import { agentEnvProblems } from './agent-env';
import { wsAuthModeProblem } from './ws-auth-mode';

/**
 * Wartości, które leżą w repo (`.env.example`, CI, fallbacki w kodzie).
 * Sekret równy którejkolwiek z nich to sekret publiczny.
 */
const PUBLIC_SECRETS = new Set([
  'replace-me',
  'dev-secret-change-me',
  'dev-pepper',
  'ci-secret',
  'ci-pepper',
]);

const MIN_SECRET_LENGTH = 32;

export type RuntimeEnvReport = {
  production: boolean;
  /** Naruszenia, które na produkcji blokują start. Bez wartości sekretów. */
  violations: string[];
  /** To samo poza produkcją — tylko ostrzeżenie w logu. */
  warnings: string[];
};

function secretProblem(name: string, value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return `${name} jest pusty`;
  if (PUBLIC_SECRETS.has(trimmed)) return `${name} ma publiczną wartość z repo`;
  if (trimmed.length < MIN_SECRET_LENGTH) {
    return `${name} ma ${trimmed.length} znaków, minimum ${MIN_SECRET_LENGTH} (openssl rand -base64 32)`;
  }
  return null;
}

/**
 * Sprawdza zmienne środowiskowe, bez których serwer nie ma prawa wystartować
 * na produkcji — czysta funkcja, żeby dało się ją przetestować tabelą.
 *
 * Dlaczego w ogóle: `JWT_SECRET` i pepper mają w kodzie publiczne wartości
 * domyślne (`auth.module.ts`, `auth.service.ts`). Jedna zgubiona zmienna na
 * Railway = każdy token do podrobienia z ciągu, który leży w repo — czyli
 * darmowy dostęp do metered endpointu asystenta na cudzy rachunek i
 * podszywanie się pod dowolne gospodarstwo. Nic w kodzie nie czytało
 * `NODE_ENV`, więc nic nie mogło odmówić startu.
 *
 * Poza produkcją te same braki dają ostrzeżenie: dev i CI świadomie chodzą
 * na krótkich sekretach.
 */
export function inspectRuntimeEnv(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeEnvReport {
  const production = env.NODE_ENV === 'production';
  const problems: string[] = [];

  const jwtProblem = secretProblem('JWT_SECRET', env.JWT_SECRET);
  if (jwtProblem) problems.push(jwtProblem);

  const pepperProblem = secretProblem(
    'REFRESH_TOKEN_PEPPER',
    env.REFRESH_TOKEN_PEPPER,
  );
  if (pepperProblem) {
    problems.push(pepperProblem);
  } else if (
    (env.REFRESH_TOKEN_PEPPER ?? '').trim() === (env.JWT_SECRET ?? '').trim()
  ) {
    // Pepper istnieje po to, żeby wyciek jednego sekretu nie oddawał obu.
    problems.push('REFRESH_TOKEN_PEPPER jest równy JWT_SECRET');
  }

  // Literówka w trybie auth WS po cichu dawałaby `soft` — na produkcji to ma
  // być świadoma decyzja, nie przypadek.
  const wsAuthProblem = wsAuthModeProblem(env);
  if (wsAuthProblem) problems.push(wsAuthProblem);

  // Asystent AI: przy AI_ENABLED pustym/false nic nie jest wymagane (merge bez
  // zmiennych na Railway); `true` z dostawcą anthropic wymaga klucza.
  problems.push(...agentEnvProblems(env));

  // Limity throttlera: zła wartość po cichu wracałaby do domyślnej, a na
  // produkcji ma to być widoczne.
  problems.push(...throttleEnvProblems(env));

  // Poniższe mają sens tylko na produkcji — dev bez Cookidoo ma prawo żyć.
  const productionOnly: string[] = [];
  if (!(env.DATABASE_URL ?? '').trim()) {
    productionOnly.push('DATABASE_URL jest pusty');
  }
  if (!(env.COOKIDOO_SERVICE_TOKEN ?? '').trim()) {
    productionOnly.push(
      'COOKIDOO_SERVICE_TOKEN jest pusty (pusty token = 503 przy pierwszym użyciu integracji)',
    );
  }
  try {
    parseEncryptionKey(env.COOKIDOO_ENCRYPTION_KEY);
  } catch (error) {
    productionOnly.push(
      error instanceof Error ? error.message : 'COOKIDOO_ENCRYPTION_KEY',
    );
  }
  if (!(env.OPS_TOKEN ?? '').trim()) {
    productionOnly.push('OPS_TOKEN jest pusty (chroni /ops/metrics)');
  }
  if (env.AUTH_DEV_LOGIN_ENABLED === 'true') {
    productionOnly.push(
      'AUTH_DEV_LOGIN_ENABLED=true — dev-login na produkcji wybija tokeny każdemu',
    );
  }

  return production
    ? { production, violations: [...problems, ...productionOnly], warnings: [] }
    : { production, violations: [], warnings: problems };
}

/**
 * Do wołania jako pierwsza linia `bootstrap()`, PRZED `NestFactory.create` —
 * odmowa startu ma być głośna i natychmiastowa, nie 500 przy pierwszym
 * logowaniu.
 */
export function assertRuntimeEnv(
  env: NodeJS.ProcessEnv = process.env,
  log: Pick<Console, 'warn'> = console,
): void {
  const report = inspectRuntimeEnv(env);
  for (const warning of report.warnings) {
    log.warn(`[env] ${warning}`);
  }
  if (report.violations.length > 0) {
    throw new Error(
      `Odmowa startu (NODE_ENV=production) — popraw zmienne środowiskowe:\n - ${report.violations.join('\n - ')}`,
    );
  }
}
