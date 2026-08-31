/**
 * Postęp tury — to, co telefon pokazuje przez te trzydzieści sekund.
 *
 * Tura trwa 25–60 s, a klient odpytuje `GET /agent/turns/:id` co sekundę.
 * Kolumna `AgentTurn.progress` istniała od Fazy 0 i przez cały ten czas
 * wracała pusta: kontrakt obiecywał kroki, klient dostawał `[]` i mógł
 * pokazać wyłącznie kręciołek. Tu powstają wpisy, które ten kontrakt wypełniają.
 *
 * Etykieta jest gotowym zdaniem PO POLSKU, a nie kodem do przetłumaczenia na
 * kliencie — tak samo jak komunikaty błędów z serwera. Klient, który chce
 * własnej ikony albo własnego tekstu, ma `tool`; klient, który nie chce nic
 * mapować, ma `label` i działa od pierwszego dnia.
 */
export type AgentProgressStep = {
  /** Nazwa narzędzia (`apply_week_plan`) — dla klienta z własną mapą. */
  tool: string;
  /** Gotowe zdanie do pokazania użytkownikowi. */
  label: string;
  /** Kiedy krok się zaczął (ISO 8601, UTC). */
  at: string;
};

/**
 * Etykiety mówią, co asystent ROBI DLA UŻYTKOWNIKA, a nie jak nazywa się
 * narzędzie. „Czytam plan tygodnia" jest zrozumiałe; „get_week_plan" nie jest.
 */
const LABELS: Record<string, string> = {
  get_household_context: 'Sprawdzam, kto je i jakie ma cele',
  get_week_plan: 'Czytam plan tygodnia',
  get_week_balance: 'Liczę bilans dnia',
  search_ingredients: 'Szukam składników',
  apply_week_plan: 'Zapisuję plan tygodnia',
  create_recipe: 'Dodaję przepis',
  update_recipe: 'Poprawiam przepis',
  delete_recipe: 'Wycofuję przepis',
};

/** Narzędzie spoza listy (nowe, jeszcze bez etykiety) nie może zostawić pustki. */
export const PROGRESS_FALLBACK = 'Pracuję nad tym';

/**
 * Krok postępu dla wywołania narzędzia.
 *
 * `apply_week_plan` ma dwie twarze i użytkownik musi je rozróżniać: próba
 * (`dry_run`) niczego nie zmienia, a zapis zmienia jego tydzień. Pokazanie
 * „Zapisuję plan" przy suchym przebiegu byłoby po prostu nieprawdą.
 */
export function progressStep(
  tool: string,
  input: Record<string, unknown> = {},
  now: Date = new Date(),
): AgentProgressStep {
  const label =
    tool === 'apply_week_plan' && input.dry_run === true
      ? 'Sprawdzam, czy plan się spina'
      : (LABELS[tool] ?? PROGRESS_FALLBACK);
  return { tool, label, at: now.toISOString() };
}

/**
 * Dokłada krok, chyba że powtarza poprzedni.
 *
 * Model potrafi wywołać `search_ingredients` osiem razy pod rząd — osiem
 * identycznych wierszy to nie jest postęp, tylko szum. Zwraca `true`, gdy
 * lista się zmieniła i warto ją zapisać.
 */
export function appendProgress(
  steps: AgentProgressStep[],
  step: AgentProgressStep,
): boolean {
  const last = steps[steps.length - 1];
  if (last && last.tool === step.tool && last.label === step.label) {
    return false;
  }
  steps.push(step);
  return true;
}
