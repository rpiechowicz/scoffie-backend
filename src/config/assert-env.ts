import { parseEncryptionKey } from '../common/crypto.util';
import { throttleEnvProblems } from '../common/throttle/throttle-env';
import { agentEnvProblems } from './agent-env';
import { billingEnvProblems } from './billing-env-problems';
import { wsAuthModeProblem, wsAuthModeProductionProblem } from './ws-auth-mode';

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

/**
 * Mikroserwis Cookidoo dostaje JAWNE hasła użytkowników do Vorwerka, więc na
 * produkcji wolno do niego mówić tylko po https albo po sieci prywatnej
 * Railway (`*.railway.internal`) — publiczny `http://` wysyłałby te hasła
 * otwartym tekstem przez internet.
 */
export function cookidooServiceUrlProblem(
  raw: string | undefined,
): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null; // klient używa localhost:8000
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'COOKIDOO_SERVICE_URL nie jest poprawnym adresem http(s)';
  }
  // `cookidoo:8000` parsuje się jako schemat `cookidoo:` — to też nie jest
  // adres, pod który klient HTTP potrafi zapukać.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'COOKIDOO_SERVICE_URL nie jest poprawnym adresem http(s)';
  }
  if (url.protocol === 'https:') return null;
  const host = url.hostname.toLowerCase();
  const privateHost =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.internal') ||
    host.endsWith('.local');
  if (url.protocol === 'http:' && privateHost) return null;
  return `COOKIDOO_SERVICE_URL=${url.protocol}//${host} — hasła Cookidoo szłyby jawnie; użyj https albo hosta *.railway.internal`;
}

/** Baza na tej samej maszynie (dev, CI, docker-compose) — tylko tam wolno żyć sekretom z repo. */
export function isLocalDatabaseUrl(raw: string | undefined): boolean {
  const value = (raw ?? '').trim();
  if (!value) return true;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === 'postgres' ||
      host === 'db' ||
      host.endsWith('.local') ||
      host.endsWith('.internal')
    );
  } catch {
    return false;
  }
}

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
  // Jawne `soft` na produkcji = podszywanie się po WS pod dowolne konto.
  const wsSoftProblem = wsAuthModeProductionProblem(env);
  if (wsSoftProblem) problems.push(wsSoftProblem);

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
  const cookidooUrlProblem = cookidooServiceUrlProblem(
    env.COOKIDOO_SERVICE_URL,
  );
  if (cookidooUrlProblem) productionOnly.push(cookidooUrlProblem);
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
  // Długość OPS_TOKEN to ostrzeżenie, nie blokada startu: token chroni
  // nadawanie PRO i cofanie subskrypcji, więc ma być losowy i długi — ale
  // krótki token na Railway nie może położyć całej aplikacji przy deployu.
  const productionWarnings: string[] = [];
  const opsTokenProblem = secretProblem('OPS_TOKEN', env.OPS_TOKEN);
  if ((env.OPS_TOKEN ?? '').trim() && opsTokenProblem) {
    productionWarnings.push(
      `${opsTokenProblem} — zrotuj na dłuższy przy najbliższej okazji`,
    );
  }
  if (env.AUTH_DEV_LOGIN_ENABLED === 'true') {
    productionOnly.push(
      'AUTH_DEV_LOGIN_ENABLED=true — dev-login na produkcji wybija tokeny każdemu',
    );
  }
  // Płatności NIGDY nie blokują startu — nawet na produkcji. Zablokowany
  // deploy to cała aplikacja w dół; niedokonfigurowany paywall to tylko
  // paywall, który się nie włączy. Dlatego zawsze `warnings`.
  const billingWarnings = billingEnvProblems(env, {
    localDatabase: isLocalDatabaseUrl(env.DATABASE_URL),
  });

  if (production) {
    return {
      production,
      violations: [...problems, ...productionOnly],
      warnings: [...productionWarnings, ...billingWarnings],
    };
  }
  // Poza produkcją sekrety z repo są dopuszczalne TYLKO przy lokalnej bazie.
  // Staging z `NODE_ENV` innym niż production i bazą w chmurze startował
  // dotąd z `dev-secret-change-me` — każdy mógł podpisać sobie token.
  const remoteDatabase = !isLocalDatabaseUrl(env.DATABASE_URL);
  const secretViolations = remoteDatabase
    ? [jwtProblem, pepperProblem].filter((p): p is string => Boolean(p))
    : [];
  return {
    production,
    violations: secretViolations.map(
      (problem) =>
        `${problem} (baza nielokalna — sekret z repo nie wchodzi w grę)`,
    ),
    warnings: [
      ...problems.filter((problem) => !secretViolations.includes(problem)),
      ...billingWarnings,
    ],
  };
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
