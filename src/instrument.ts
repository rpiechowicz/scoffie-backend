import * as Sentry from '@sentry/nestjs';

/**
 * Śledzenie błędów (Sentry). Włącza się WYŁĄCZNIE ustawionym `SENTRY_DSN` —
 * bez zmiennej wszystkie wywołania `Sentry.*` są no-opami, więc dev, CI
 * i produkcja bez konta Sentry działają jak dotąd.
 *
 * Ten plik musi być pierwszym importem `main.ts`: SDK owija moduły Node
 * (http, pg) zanim Nest je załaduje.
 *
 * Co idzie do Sentry: typ i ślad błędu, ścieżka, kod błędu, identyfikator
 * żądania, wersja (commit). Co NIE idzie: nagłówki (token), cookies, ciało
 * żądania, treści wiadomości do asystenta, dane profilu. `scrubEvent`
 * pilnuje tego na wyjściu — polityka prywatności §9 wymienia Sentry jako
 * odbiorcę „danych technicznych błędów", i tylko tyle ma dostać.
 */
const dsn = (process.env.SENTRY_DSN ?? '').trim();

type SentryEvent = Sentry.ErrorEvent;

export function scrubEvent<T extends SentryEvent>(event: T): T {
  if (event.request) {
    delete event.request.headers;
    delete event.request.cookies;
    delete event.request.data;
    delete event.request.query_string;
  }
  if (event.user) {
    // Tylko identyfikator — bez e-maila, nazwy i IP (do korelacji z logami).
    event.user = event.user.id ? { id: event.user.id } : undefined;
  }
  return event;
}

Sentry.init({
  dsn,
  enabled: dsn.length > 0,
  environment: process.env.NODE_ENV ?? 'development',
  release: process.env.RAILWAY_GIT_COMMIT_SHA || undefined,
  // Wydajność opcjonalna i tania: domyślnie 0 (tylko błędy).
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0') || 0,
  sendDefaultPii: false,
  beforeSend: (event) => scrubEvent(event),
  // Okruchy (breadcrumbs) NIE przechodzą przez `beforeSend`, tylko przez ten
  // hak — a SDK zbiera je sam z modułów http i pg, czyli z adresów żądań
  // i treści zapytań SQL. `scrubEvent` ich nie widzi, więc jedyny sposób,
  // żeby nie wysyłać czegoś, czego nie sprawdziliśmy, to nie wysyłać nic.
  // Do diagnozy wystarcza ślad wyjątku i `requestId` do wyszukania w logu.
  // (Audyt 12.09.2026, P1.15.)
  beforeBreadcrumb: () => null,
});
