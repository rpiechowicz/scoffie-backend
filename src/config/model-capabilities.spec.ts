import { capabilitiesFor, THINKING_BUDGET_TOKENS } from './model-capabilities';

/**
 * Ten plik pilnuje jednej rzeczy, która kosztowałaby użytkowników pieniądze:
 * kształt pól myślenia zależy od MODELU. Zły kształt to 400 z API —
 * nieponawialne, więc tura pada, a kwota z miesięcznego limitu NIE wraca.
 */
describe('capabilitiesFor', () => {
  it('modele 5 myślą adaptacyjnie i przyjmują effort', () => {
    for (const model of ['claude-sonnet-5', 'claude-opus-5']) {
      expect(capabilitiesFor(model)).toEqual({
        thinking: 'adaptive',
        effort: true,
        known: true,
      });
    }
  });

  it('Haiku 4.5 chce budżetu myślenia i NIE przyjmuje effort', () => {
    expect(capabilitiesFor('claude-haiku-4-5')).toEqual({
      thinking: 'budget',
      effort: false,
      known: true,
    });
  });

  it('nieznany model dostaje kształt modeli najnowszych i jest oznaczony', () => {
    const caps = capabilitiesFor('claude-sonnet-9');
    expect(caps.thinking).toBe('adaptive');
    expect(caps.known).toBe(false);
  });

  it('budżety myślenia mieszczą się w granicach API (≥1024, <16000), a `low` nie myśli wcale', () => {
    expect(THINKING_BUDGET_TOKENS.low).toBeUndefined();
    for (const level of ['medium', 'high', 'xhigh', 'max']) {
      const budget = THINKING_BUDGET_TOKENS[level];
      expect(budget).toBeGreaterThanOrEqual(1024);
      expect(budget).toBeLessThan(16_000);
    }
  });
});
