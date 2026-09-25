/**
 * Logowanie przez Google (aplikacja Android) — konfiguracja.
 *
 * `GOOGLE_OAUTH_CLIENT_IDS` to lista identyfikatorów klientów OAuth (po
 * przecinku), które wolno przyjąć jako `aud` tokenu tożsamości Google. Android
 * podaje w Credential Managerze `serverClientId` = identyfikator klienta typu
 * „Web application", więc to ON ląduje w `aud` i to on ma być na tej liście.
 *
 * Brak zmiennej NIE blokuje startu: `POST /auth/google` odpowiada wtedy 503
 * `SERVICE_UNAVAILABLE` („wyłączone w tej instalacji”; kod ogólny, bez
 * nowej kopii w klientach), a reszta API (w tym Apple) działa jak dotąd.
 * Czytane per żądanie — włączenie nie wymaga builda, tylko zmiennej.
 */
export function readGoogleOAuthClientIds(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return (env.GOOGLE_OAUTH_CLIENT_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

const GOOGLE_CLIENT_ID_SUFFIX = '.apps.googleusercontent.com';

/**
 * Ostrzeżenia (nigdy blokada startu): pusta lista to świadomie wyłączone
 * logowanie, ale wpis, który nie wygląda na identyfikator klienta Google,
 * to prawie na pewno pomyłka przy wklejaniu (np. sekret klienta zamiast ID)
 * — a skutkiem byłoby 401 przy KAŻDYM logowaniu z Androida.
 */
export function googleAuthEnvProblems(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const invalid = readGoogleOAuthClientIds(env).filter(
    (id) => !id.endsWith(GOOGLE_CLIENT_ID_SUFFIX),
  );
  if (invalid.length === 0) return [];
  return [
    `GOOGLE_OAUTH_CLIENT_IDS: ${invalid.length} wpis(y) bez sufiksu ${GOOGLE_CLIENT_ID_SUFFIX} — logowanie przez Google z takim klientem zawsze się nie powiedzie`,
  ];
}
