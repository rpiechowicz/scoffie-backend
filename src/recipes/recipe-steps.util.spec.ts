import { normalizeRecipeSteps } from './recipe-steps.util';

describe('normalizeRecipeSteps', () => {
  it('brak pola znaczy „nie ruszaj kroków", nie „wyczyść"', () => {
    expect(normalizeRecipeSteps(undefined)).toBeUndefined();
  });

  it('pusta lista czyści kroki', () => {
    expect(normalizeRecipeSteps([])).toEqual([]);
  });

  it('numeruje od 1 po kolei, nawet gdy klient tego nie zrobił', () => {
    expect(
      normalizeRecipeSteps([{ text: 'Podsmaż' }, { text: 'Duś' }]),
    ).toEqual([
      { stepNumber: 1, text: 'Podsmaż' },
      { stepNumber: 2, text: 'Duś' },
    ]);
  });

  it('numery z wejścia ustalają kolejność, ale nie zostają', () => {
    // Model potrafi podać „1, 2, 2, 5" — bez przenumerowania zapisalibyśmy
    // przepis z duplikatem i dziurą.
    expect(
      normalizeRecipeSteps([
        { stepNumber: 5, text: 'Podawaj' },
        { stepNumber: 2, text: 'Duś' },
        { stepNumber: 2, text: 'Dopraw' },
        { stepNumber: 1, text: 'Podsmaż' },
      ]),
    ).toEqual([
      { stepNumber: 1, text: 'Podsmaż' },
      { stepNumber: 2, text: 'Duś' },
      { stepNumber: 3, text: 'Dopraw' },
      { stepNumber: 4, text: 'Podawaj' },
    ]);
  });

  it('przy tym samym numerze decyduje kolejność w tablicy', () => {
    expect(
      (
        normalizeRecipeSteps([
          { stepNumber: 1, text: 'Pierwszy' },
          { stepNumber: 1, text: 'Drugi' },
        ]) ?? []
      ).map((step) => step.text),
    ).toEqual(['Pierwszy', 'Drugi']);
  });

  it('przycina białe znaki i wyrzuca puste kroki', () => {
    expect(
      normalizeRecipeSteps([
        { text: '  Podsmaż cebulę.  ' },
        { text: '   ' },
        { text: 'Dodaj pomidory.' },
      ]),
    ).toEqual([
      { stepNumber: 1, text: 'Podsmaż cebulę.' },
      { stepNumber: 2, text: 'Dodaj pomidory.' },
    ]);
  });

  it('numeracja nie ma dziur po odsianiu pustych', () => {
    const steps =
      normalizeRecipeSteps([
        { stepNumber: 1, text: 'A' },
        { stepNumber: 2, text: '' },
        { stepNumber: 3, text: 'B' },
      ]) ?? [];
    expect(steps.map((step) => step.stepNumber)).toEqual([1, 2]);
  });
});
