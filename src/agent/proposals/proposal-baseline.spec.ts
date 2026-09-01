import { weekBaselineHash } from './proposal-baseline';

// Odcisk stanu tygodnia decyduje o tym, kiedy propozycja robi się nieaktualna.
// Za czuły — użytkownik dostaje „plan się zmienił” po zapisie, który niczego
// nie zmienił. Za mało czuły — zatwierdzenie po cichu nadpisuje cudzą zmianę.

const slot = (over: Record<string, unknown> = {}) => ({
  dayOfWeek: 'MON',
  mealType: 'LUNCH',
  recipeId: 'r-1',
  participantIds: [],
  plannedServings: 2,
  ...over,
});

describe('weekBaselineHash', () => {
  it('nie zależy od kolejności pozycji ani uczestników', () => {
    const a = weekBaselineHash([
      slot({ participantIds: ['u1', 'u2'] }),
      slot({ dayOfWeek: 'TUE', recipeId: 'r-2' }),
    ]);
    const b = weekBaselineHash([
      slot({ dayOfWeek: 'TUE', recipeId: 'r-2' }),
      slot({ participantIds: ['u2', 'u1'] }),
    ]);

    expect(a).toBe(b);
  });

  it.each([
    ['inny przepis', slot({ recipeId: 'r-9' })],
    ['inny dzień', slot({ dayOfWeek: 'SUN' })],
    ['inny posiłek', slot({ mealType: 'DINNER' })],
    ['inne porcje', slot({ plannedServings: 4 })],
    ['inne audytorium', slot({ participantIds: ['u1'] })],
  ])('wykrywa zmianę: %s', (_label, changed) => {
    expect(weekBaselineHash([slot()])).not.toBe(weekBaselineHash([changed]));
  });

  it('pusty tydzień ma swój odcisk i jest stabilny', () => {
    expect(weekBaselineHash([])).toBe(weekBaselineHash([]));
    expect(weekBaselineHash([])).not.toBe(weekBaselineHash([slot()]));
  });

  it('brak porcji to nie to samo co porcje ustawione ręcznie', () => {
    expect(weekBaselineHash([slot({ plannedServings: null })])).not.toBe(
      weekBaselineHash([slot({ plannedServings: 2 })]),
    );
  });
});
