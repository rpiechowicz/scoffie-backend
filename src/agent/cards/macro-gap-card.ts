import {
  AGENT_CARD_VERSION,
  MacroGapBooster,
  MacroGapCard,
  MacroKey,
} from './agent-cards';

/** Nazwa makra w mianowniku — do nadtytułu karty. */
export const MACRO_LABELS: Record<MacroKey, string> = {
  PROTEIN: 'Białko',
  FAT: 'Tłuszcz',
  CARBS: 'Węglowodany',
  KCAL: 'Kalorie',
};

const MACRO_UNITS: Record<MacroKey, string> = {
  PROTEIN: 'g',
  FAT: 'g',
  CARBS: 'g',
  KCAL: 'kcal',
};

/** Ile propozycji zmian ma sens — dalej to lista zadań, nie podpowiedź. */
export const MAX_BOOSTERS = 3;

/**
 * Luka między planem a celem.
 *
 * Liczby są POLICZONE (bilans tygodnia + cel z profilu), a nie przepisane
 * z pamięci modelu — inaczej „brakuje 44 g białka” wyglądałoby identycznie
 * jak prawda i nie dałoby się ich odróżnić. Model dokłada wyłącznie pomysły
 * na zmianę, bo to jedyna część, której nie da się policzyć.
 *
 * Karta nic nie zapisuje: „zastosuj” wysyła zwykłą wiadomość, po której model
 * układa konkretną propozycję do zatwierdzenia. Zapis w tym miejscu znaczyłby
 * podmianę trzech dań, których użytkownik jeszcze nie widział.
 */
export function buildMacroGapCard(input: {
  macro: MacroKey;
  current: number;
  target: number;
  boosters: readonly MacroGapBooster[];
  /** „ten tydzień” albo imię domownika — czego dotyczy zestawienie. */
  scopeLabel: string;
}): MacroGapCard {
  const boosters = input.boosters.slice(0, MAX_BOOSTERS);
  const gap = input.target - input.current;
  const unit = MACRO_UNITS[input.macro];

  return {
    kind: 'MACRO_GAP',
    v: AGENT_CARD_VERSION,
    eyebrow: `${MACRO_LABELS[input.macro]} · ${input.scopeLabel}`,
    title: gapTitle(gap, unit),
    macro: input.macro,
    unit,
    current: input.current,
    target: input.target,
    boosters,
    actions:
      boosters.length > 0
        ? [
            {
              type: 'ASK',
              proposalId: null,
              label:
                boosters.length === 1
                  ? 'Zastosuj tę zmianę'
                  : `Zastosuj wszystkie ${boosters.length === 2 ? 'dwie' : 'trzy'}`,
              style: 'PRIMARY',
              prompt:
                'Zastosuj te zmiany w planie i pokaż mi je jako propozycję.',
            },
          ]
        : [],
  };
}

/**
 * Tytuł mówi, ile brakuje — albo że nie brakuje nic.
 *
 * Karta z tytułem „Białko” i paskiem obok wymagałaby policzenia różnicy
 * wzrokiem. Ta różnica JEST treścią, więc stoi w tytule.
 */
function gapTitle(gap: number, unit: string): string {
  if (gap <= 0) return `Cel dowieziony, z zapasem ${Math.abs(gap)} ${unit}`;
  return `Brakuje średnio ${gap} ${unit} dziennie`;
}
