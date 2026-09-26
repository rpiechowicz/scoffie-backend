/**
 * Adres do logu bez sekretów z zapytania (`?token=…` webhooka Railwaya).
 * Logi idą na stdout Railwaya i — przy `warn`/`error` — do Sentry.
 */
export const redactUrl = (url: string): string =>
  url.replace(/([?&](?:token|secret)=)[^&#]*/gi, '$1***');
