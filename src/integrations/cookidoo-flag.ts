/**
 * Przełącznik integracji Cookidoo (Thermomix) — czytany per wywołanie, jak
 * reszta flag wdrożeniowych.
 *
 * Domyślnie WŁĄCZONA (brak zmiennej = jak dotąd), wyłącza ją wyłącznie
 * literalne `false`. Powód istnienia (audyt 2.09.2026): użytkownik oddaje
 * hasło do cudzej usługi przez nieoficjalne API, a funkcja obejmuje 1 z 97
 * przepisów katalogu — do czasu 30 przepisów TM i zapisów w regulaminie ma
 * być schowana. Wyłączenie nie kasuje poświadczeń: `disconnect` działa
 * dalej, żeby użytkownik mógł je usunąć.
 */
export function isCookidooIntegrationEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    (env.COOKIDOO_INTEGRATION_ENABLED ?? '').trim().toLowerCase() !== 'false'
  );
}
