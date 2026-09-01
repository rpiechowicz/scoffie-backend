import {
  AGENT_CARD_VERSION,
  OptionsCard,
  OptionsCardItem,
} from './agent-cards';

/** Ile propozycji mieści się w karuzeli, zanim stanie się listą. */
export const MAX_OPTIONS = 4;

/**
 * Kilka dań do wyboru — pytanie zadane obrazkami.
 *
 * Karta nie niesie propozycji ani stanu. Dotknięcie wysyła zwykłą wiadomość,
 * a dopiero odpowiedź modelu kończy się czymś, co da się zatwierdzić.
 * Wersja, w której dotknięcie od razu zapisuje, wymagałaby policzenia
 * czterech pełnych podglądów tygodnia z góry — czyli zapłacenia za cztery
 * propozycje po to, żeby użyć jednej.
 */
export function buildOptionsCard(input: {
  title: string;
  slotLabel?: string | null;
  options: readonly OptionsCardItem[];
}): OptionsCard {
  return {
    kind: 'OPTIONS',
    v: AGENT_CARD_VERSION,
    eyebrow: input.slotLabel?.trim() ? input.slotLabel.trim() : 'Do wyboru',
    title: input.title.trim(),
    options: input.options.slice(0, MAX_OPTIONS),
    actions: [
      // Czwarta opcja to „żadna z tych”. Bez niej użytkownik, któremu nic
      // nie pasuje, musi wymyślić zdanie i napisać je na klawiaturze —
      // czyli najczęściej nie odpowiada wcale.
      {
        type: 'ASK',
        proposalId: null,
        label: 'Coś innego',
        style: 'SECONDARY',
        prompt: 'Żadne z tych mi nie pasuje. Zaproponuj coś innego.',
      },
    ],
  };
}

/** Zdanie wysyłane po dotknięciu kafelka — wybór, a nie polecenie. */
export function optionPrompt(title: string): string {
  return `Wybieram: ${title}`;
}
