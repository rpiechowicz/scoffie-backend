/**
 * Przełącznik integracji Cookidoo (Thermomix) — czytany per wywołanie, jak
 * reszta flag wdrożeniowych.
 *
 * Domyślnie WYŁĄCZONA (od 6.10.2026), włącza ją wyłącznie literalne `true`.
 * Powód (audyt 2.09.2026): użytkownik oddaje hasło do cudzej usługi przez
 * nieoficjalne API, a na integrację nie mamy zgody Vorwerka — do tego czasu
 * Thermomix ma być schowany wszędzie (aplikacje, strona, dokumenty prawne).
 * Wcześniej brak zmiennej znaczył „włączona”, więc jedno przeoczenie na
 * produkcji odsłaniało funkcję. Wyłączenie nie kasuje poświadczeń:
 * `disconnect` działa dalej, żeby użytkownik mógł je usunąć.
 */
export function isCookidooIntegrationEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    (env.COOKIDOO_INTEGRATION_ENABLED ?? '').trim().toLowerCase() === 'true'
  );
}
