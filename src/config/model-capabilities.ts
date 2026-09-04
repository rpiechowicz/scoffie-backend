/**
 * Czym da się sterować głębokością myślenia W DANYM MODELU.
 *
 * Nie każdy model przyjmuje ten sam kształt żądania, a pomyłka nie kończy
 * się gorszą odpowiedzią, tylko **400 z API** — a 400 jest nieponawialny,
 * więc tura pada, kwota użytkownika NIE wraca i wygląda to jak awaria
 * aplikacji. Dokładnie to stałoby się po ustawieniu
 * `AI_MODEL_TOOLS=claude-haiku-4-5` na kodzie sprzed tego pliku: prowajder
 * wysyłał `thinking: adaptive` + `output_config.effort` do KAŻDEGO modelu.
 *
 * Dwie osie, bo są niezależne (dokumentacja „Extended thinking” →
 * „Migrating to adaptive thinking”, sprawdzone 3.09.2026):
 *
 * - `thinking`:
 *   - `adaptive` — model sam decyduje, ile myśleć: `thinking: {type:'adaptive'}`.
 *     Modele 4.7 i nowsze ODRZUCAJĄ `type:'enabled'` błędem 400.
 *   - `budget` — trzeba podać budżet: `thinking: {type:'enabled', budget_tokens}`
 *     (min. 1024, mniej niż `max_tokens`) albo nie wysyłać `thinking` wcale.
 *     Te modele ODRZUCAJĄ `type:'adaptive'` błędem 400.
 * - `effort`: czy model przyjmuje `output_config.effort`. Sonnet 5 i Opus 5 —
 *   tak; Haiku 4.5 — NIE; Opus 4.5 — tak (jedyny model „tylko budżet”, który
 *   effort przyjmuje).
 *
 * Nieznany model dostaje `adaptive` + `effort`, bo tak zachowują się modele
 * najnowsze i tak działał kod do tej pory — czyli dołożenie nowego Sonneta
 * do `AI_MODEL` nie wymaga zmiany w tym pliku, a dołożenie starszego modelu
 * wymaga wpisu (i mówi o tym ostrzeżenie w prowajderze).
 */
export type ThinkingMode = 'adaptive' | 'budget';

export type ModelCapabilities = {
  thinking: ThinkingMode;
  /** Czy `output_config.effort` jest akceptowany. */
  effort: boolean;
};

export const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  'claude-fable-5-1': { thinking: 'adaptive', effort: true },
  'claude-mythos-5-1': { thinking: 'adaptive', effort: true },
  'claude-opus-5': { thinking: 'adaptive', effort: true },
  'claude-opus-4-8': { thinking: 'adaptive', effort: true },
  'claude-opus-4-7': { thinking: 'adaptive', effort: true },
  'claude-sonnet-5': { thinking: 'adaptive', effort: true },
  // Tylko budżet myślenia:
  'claude-opus-4-5': { thinking: 'budget', effort: true },
  'claude-sonnet-4-5': { thinking: 'budget', effort: false },
  'claude-haiku-4-5': { thinking: 'budget', effort: false },
};

export const DEFAULT_CAPABILITIES: ModelCapabilities = {
  thinking: 'adaptive',
  effort: true,
};

export function capabilitiesFor(model: string): ModelCapabilities & {
  known: boolean;
} {
  const known = MODEL_CAPABILITIES[model];
  return known
    ? { ...known, known: true }
    : { ...DEFAULT_CAPABILITIES, known: false };
}

/**
 * Budżet myślenia dla modeli „tylko budżet”, w tokenach, wg poziomu wysiłku.
 *
 * `low` NIE ma wpisu celowo: na tanim modelu w fazie rozmowy myślenie jest
 * największą pozycją rachunku (model kosztowy: Haiku z myśleniem ≈ 3× Haiku
 * bez myślenia), a przepisywanie danych z narzędzi myślenia nie potrzebuje.
 * Brak wpisu = żądanie bez pola `thinking`.
 *
 * Wszystkie wartości ≥ 1024 (minimum API) i < `MAX_TOKENS` (16 000) —
 * budżet musi zostawić miejsce na odpowiedź.
 */
export const THINKING_BUDGET_TOKENS: Partial<Record<string, number>> = {
  medium: 2048,
  high: 4096,
  xhigh: 8192,
  max: 8192,
};
