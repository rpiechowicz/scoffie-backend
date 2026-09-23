import * as Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

/**
 * Obserwowalność w Sentry. Włącza się WYŁĄCZNIE ustawionym `SENTRY_DSN` —
 * bez zmiennej wszystkie wywołania `Sentry.*` są no-opami, więc dev, CI
 * i produkcja bez konta Sentry działają jak dotąd.
 *
 * Ten plik musi być pierwszym importem `main.ts`: SDK owija moduły Node
 * (http, pg) zanim Nest je załaduje.
 *
 * Sygnały i ich przełączniki (wszystkie zmienne, żeby wyłączenie nie
 * wymagało wdrożenia kodu):
 * - błędy — zawsze przy DSN (5xx, patrz `captureUnexpected`);
 * - ślady wydajności — `SENTRY_TRACES_SAMPLE_RATE` (domyślnie 0);
 * - profile CPU — `SENTRY_PROFILE_SESSION_SAMPLE_RATE` (domyślnie 0,
 *   działa tylko razem ze śladami: profil obejmuje czas trwania spanu);
 * - logi `warn`/`error` — `SENTRY_LOGS=true` (patrz `SentryForwardingLogger`);
 * - metryki — liczniki asystenta, błędów WS i 429, zawsze przy DSN.
 *
 * Co idzie do Sentry: typ i ślad błędu, ścieżka, kod błędu, identyfikator
 * żądania i użytkownika, czasy, wersja (commit). Co NIE idzie: nagłówki
 * (token), cookies, ciało i query żądania, IP, user-agent, e-maile, treści
 * wiadomości do asystenta, dane profilu. Pilnują tego haki `beforeSend*`
 * poniżej — polityka prywatności §9 wymienia Sentry jako odbiorcę „danych
 * technicznych", i tylko tyle ma dostać.
 */
const dsn = (process.env.SENTRY_DSN ?? '').trim();

function rate(name: string): number {
  const value = Number(process.env[name] ?? '0');
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;
}

const tracesSampleRate = rate('SENTRY_TRACES_SAMPLE_RATE');
const profileSessionSampleRate = rate('SENTRY_PROFILE_SESSION_SAMPLE_RATE');
const enableLogs = (process.env.SENTRY_LOGS ?? '').trim() === 'true';

export function scrubEvent<T extends Sentry.Event>(event: T): T {
  if (event.request) {
    delete event.request.headers;
    delete event.request.cookies;
    delete event.request.data;
    delete event.request.query_string;
    if (event.request.url) event.request.url = stripQuery(event.request.url);
  }
  if (event.user) {
    // Tylko identyfikator — bez e-maila, nazwy i IP (do korelacji z logami).
    event.user = event.user.id ? { id: event.user.id } : undefined;
  }
  return event;
}

function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/**
 * Atrybuty spanów HTTP niosą pełny adres z query (`?email=…`, tokeny
 * w linkach). Ścieżka zostaje — to po niej grupujemy wolne endpointy.
 */
export function scrubSpanData(data: Record<string, unknown> | undefined): void {
  if (!data) return;
  for (const key of ['http.query', 'url.query', 'http.fragment']) {
    delete data[key];
  }
  for (const key of ['url.full', 'http.url', 'http.target', 'url']) {
    const value = data[key];
    if (typeof value === 'string') data[key] = stripQuery(value);
  }
}

/**
 * Zapytanie Prismy BEZ żądania nad sobą (worker poczty, zadania w tle
 * odpytujące bazę co chwilę) staje się własną transakcją. Pierwsza godzina
 * na prod: 300 takich na godzinę przy 10% próbkowania, zero wartości —
 * a zjadają limit śladów. Zapytania wewnątrz żądania HTTP zostają.
 */
export function isOrphanDbTransaction(event: Sentry.Event): boolean {
  return (event.transaction ?? '').startsWith('prisma:');
}

/**
 * Linia logu żądania (`RequestLoggingInterceptor`) ma `ip=` i `ua=` — do
 * Railway tak, do Sentry nie. `ua=` jest ostatnie i zawiera spacje, więc
 * ucinamy do końca linii. Adres ścieżki traci query, e-maile idą w maskę.
 */
export function scrubLogMessage(message: string): string {
  return message
    .replace(/\s+ua=.*$/s, '')
    .replace(/\s+ip=\S+/g, '')
    .replace(/(\/[^\s?]*)\?\S*/g, '$1')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]');
}

Sentry.init({
  dsn,
  enabled: dsn.length > 0,
  environment: process.env.NODE_ENV ?? 'development',
  release: process.env.RAILWAY_GIT_COMMIT_SHA || undefined,
  tracesSampleRate,
  // Profiler (natywny dodatek V8) włączamy tylko, gdy ma co profilować:
  // bez śladów nie ma spanów, więc nie ma okna, w którym by próbkował.
  ...(dsn && tracesSampleRate > 0 && profileSessionSampleRate > 0
    ? {
        integrations: [nodeProfilingIntegration()],
        profileSessionSampleRate,
        profileLifecycle: 'trace' as const,
      }
    : {}),
  enableLogs,
  sendDefaultPii: false,
  beforeSend: (event) => scrubEvent(event),
  beforeSendTransaction: (event) => {
    if (isOrphanDbTransaction(event)) return null;
    scrubEvent(event);
    scrubSpanData(event.contexts?.trace?.data);
    return event;
  },
  beforeSendSpan: (span) => {
    scrubSpanData(span.data);
    return span;
  },
  beforeSendLog: (log) => {
    log.message = scrubLogMessage(String(log.message));
    return log;
  },
  // Okruchy (breadcrumbs) NIE przechodzą przez `beforeSend`, tylko przez ten
  // hak — a SDK zbiera je sam z modułów http i pg, czyli z adresów żądań
  // i treści zapytań SQL. `scrubEvent` ich nie widzi, więc jedyny sposób,
  // żeby nie wysyłać czegoś, czego nie sprawdziliśmy, to nie wysyłać nic.
  // Do diagnozy wystarcza ślad wyjątku i `requestId` do wyszukania w logu.
  // (Audyt 12.09.2026, P1.15.)
  beforeBreadcrumb: () => null,
});
