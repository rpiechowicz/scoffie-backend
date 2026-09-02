/**
 * Cennik modeli ($/MTok wejścia i wyjścia) — w `src/config`, nie w
 * `src/agent`, bo czyta go też `agentEnvProblems` (asercja środowiska przy
 * starcie), a nic poza `AppModule` nie może importować modułu asystenta.
 *
 * Odczyt z cache 0,1× ceny wejścia, zapis 1-godzinny 2× (5-minutowy 1,25×,
 * ale liczymy ostrożnie w górę — patrz cost-model.md §13).
 */
export const PRICE_PER_MTOK: Record<string, { input: number; output: number }> =
  {
    'claude-opus-5': { input: 5, output: 25 },
    'claude-sonnet-5': { input: 2, output: 10 },
    'claude-haiku-4-5': { input: 1, output: 5 },
  };

export const KNOWN_MODELS: string[] = Object.keys(PRICE_PER_MTOK);

/**
 * Nieznany model liczy się po NAJDROŻSZEJ znanej stawce. Do audytu 2.09.2026
 * nieznana nazwa w `AI_MODEL` dawała koszt ZERO — budżet dobowy nigdy by
 * nie zadziałał, a księga pokazywałaby darmowe tury. Zawyżenie jest
 * bezpieczne: bezpiecznik zadziała za wcześnie, nie za późno.
 */
export const FALLBACK_MODEL = 'claude-opus-5';

export function priceFor(model: string): {
  input: number;
  output: number;
  known: boolean;
} {
  const price = PRICE_PER_MTOK[model];
  if (price) return { ...price, known: true };
  return { ...PRICE_PER_MTOK[FALLBACK_MODEL], known: false };
}
