import {
  AGENT_CARD_VERSION,
  AgentCardAction,
  ClarifyCard,
} from './agent-cards';

/** Ile gotowych odpowiedzi ma sens pod pytaniem — dalej to już menu. */
export const MAX_CLARIFY_OPTIONS = 4;

/**
 * Pytanie zamiast zgadywania.
 *
 * Model, który nie wie, czy gotujemy dla czterech osób czy dla dwóch, ma dwa
 * wyjścia: ułożyć tydzień na chybił trafił albo zapytać. Do tej pory drugie
 * wyjście znaczyło zdanie w akapicie i konieczność pisania odpowiedzi na
 * klawiaturze — czyli w praktyce nie istniało.
 *
 * Odpowiedzi są zwykłymi wiadomościami (`ASK`), a nie osobnym protokołem:
 * dzięki temu w historii rozmowy zostaje to, co użytkownik „powiedział",
 * i model widzi to w kolejnej turze bez żadnej dodatkowej pamięci.
 */
export function buildClarifyCard(input: {
  question: string;
  hint?: string | null;
  options: readonly string[];
}): ClarifyCard {
  const options = input.options
    .map((option) => option.trim())
    .filter((option) => option.length > 0)
    .slice(0, MAX_CLARIFY_OPTIONS);

  const actions: AgentCardAction[] = options.map((option, index) => ({
    type: 'ASK',
    proposalId: null,
    label: option,
    // Pierwsza odpowiedź jest wyróżniona, bo model wymienia je od
    // najbardziej prawdopodobnej — a pytanie z czterema równorzędnymi
    // przyciskami przenosi decyzję z powrotem na użytkownika.
    style: index === 0 ? 'PRIMARY' : 'SECONDARY',
    prompt: option,
  }));

  return {
    kind: 'CLARIFY',
    v: AGENT_CARD_VERSION,
    question: input.question.trim(),
    hint: input.hint?.trim() ? input.hint.trim() : null,
    actions,
  };
}
