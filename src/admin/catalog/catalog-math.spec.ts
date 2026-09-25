import {
  baseUnitFromUsage,
  comparePolish,
  kcalPerServing,
  stepsFromInstructions,
} from './catalog-math';

describe('katalog w panelu', () => {
  describe('kroki z `sourceInstructions`', () => {
    it('pisownia importu `{ step, text }` — po numerze kroku', () => {
      expect(
        stepsFromInstructions([
          { step: 2, text: 'Upiecz.' },
          { step: 1, text: 'Wymieszaj.' },
        ]),
      ).toEqual(['Wymieszaj.', 'Upiecz.']);
    });

    it('pisownia `recipes:create` `{ stepNumber, text }` i aliasy iOS', () => {
      expect(
        stepsFromInstructions([
          { stepNumber: 1, text: '  Pokrój.  ' },
          { step_number: 2, instruction: 'Podsmaż.' },
        ]),
      ).toEqual(['Pokrój.', 'Podsmaż.']);
    });

    it('bez numeru liczy się pozycja; puste kroki odpadają', () => {
      expect(
        stepsFromInstructions([
          { text: 'Pierwszy' },
          { text: '   ' },
          'Trzeci jako napis',
          42,
          null,
        ]),
      ).toEqual(['Pierwszy', 'Trzeci jako napis']);
    });

    it('nie-tablica (brak kroków, stary format) — pusta lista', () => {
      expect(stepsFromInstructions(null)).toEqual([]);
      expect(stepsFromInstructions({ step: 1, text: 'x' })).toEqual([]);
      expect(stepsFromInstructions('Wymieszaj')).toEqual([]);
    });
  });

  it('podstawa „na 100” z jednostek, w których przepisy odmierzają składnik', () => {
    expect(baseUnitFromUsage({ grams: 0, millilitres: 12 })).toBe('ml');
    expect(baseUnitFromUsage({ grams: 40, millilitres: 3 })).toBe('g');
    // Remis i brak użycia — gramy (większość katalogu).
    expect(baseUnitFromUsage({ grams: 2, millilitres: 2 })).toBe('g');
    expect(baseUnitFromUsage({ grams: 0, millilitres: 0 })).toBe('g');
  });

  it('kcal na porcję z makro CAŁEGO przepisu', () => {
    expect(kcalPerServing(822, 2)).toBe(411);
    expect(kcalPerServing(1000, 3)).toBe(333);
    // `servings` 0 w starym wierszu nie może dzielić przez zero.
    expect(kcalPerServing(500, 0)).toBe(500);
  });

  it('sortowanie po polsku: „ł” po „l”, „ż” na końcu, bez wielkości liter', () => {
    const titles = ['żurek', 'Łosoś z piekarnika', 'lody', 'ananas', 'łazanki'];
    const sorted = titles
      .map((text, index) => ({ text, id: String(index) }))
      .sort(comparePolish)
      .map((entry) => entry.text);
    expect(sorted).toEqual([
      'ananas',
      'lody',
      'łazanki',
      'Łosoś z piekarnika',
      'żurek',
    ]);
  });
});
