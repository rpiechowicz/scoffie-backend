import type { ApplyWeekSlotDto } from '../../weekly-plans/dto/apply-week-plan.dto';
import { prepareProposalSlots } from './proposal-portions';

const slot = (fields: Partial<ApplyWeekSlotDto>): ApplyWeekSlotDto => ({
  dayOfWeek: 'TUE',
  mealType: 'DINNER',
  recipeId: 'x',
  ...fields,
});

const allocatedX = slot({
  recipeId: 'x',
  portions: [
    { userId: 'a', servings: 0.9 },
    { userId: 'b', servings: 1.3 },
  ],
});

describe('prepareProposalSlots (porcje w propozycjach asystenta)', () => {
  it('pozycja z alokacją powtórzona bez porcji → PRESERVE (nie równy podział)', () => {
    const { slots, dropped } = prepareProposalSlots(
      [allocatedX],
      [slot({ recipeId: 'x' })],
      ['a', 'b'],
    );
    expect(slots).toEqual([slot({ recipeId: 'x', portionPolicy: 'PRESERVE' })]);
    expect(dropped).toEqual([]);
  });

  it('zamiana dania w tym samym posiłku → nowe danie przejmuje porcje osób; nowa osoba 1,00', () => {
    const { slots, dropped } = prepareProposalSlots(
      [allocatedX],
      [slot({ recipeId: 'y', plannedServings: 2 })],
      ['a', 'b', 'c'],
    );
    expect(slots).toEqual([
      slot({
        recipeId: 'y',
        portions: [
          { userId: 'a', servings: 0.9 },
          { userId: 'b', servings: 1.3 },
          { userId: 'c', servings: 1 },
        ],
      }),
    ]);
    expect(dropped).toEqual([]);
  });

  it('pozycja z alokacją znika bez następcy → `dropped`', () => {
    const { dropped } = prepareProposalSlots(
      [allocatedX],
      [slot({ dayOfWeek: 'MON', recipeId: 'y' })],
      ['a', 'b'],
    );
    expect(dropped).toEqual([allocatedX]);
  });

  it('jawne porcje, jawna intencja i pozycje bez alokacji zostają bez zmian', () => {
    const explicit = slot({
      recipeId: 'y',
      portions: [{ userId: 'a', servings: 2 }],
      participantIds: ['a'],
    });
    const reset = slot({ recipeId: 'x', portionPolicy: 'RESET' });
    const plain = slot({ dayOfWeek: 'MON', recipeId: 'z' });
    expect(
      prepareProposalSlots([allocatedX, plain], [explicit, plain], ['a', 'b'])
        .slots,
    ).toEqual([explicit, plain]);
    expect(
      prepareProposalSlots([allocatedX], [reset], ['a', 'b']).slots,
    ).toEqual([reset]);
  });

  it('następca dla innych osób niż znikająca alokacja → bez przejęcia, alokacja w `dropped`', () => {
    const { slots, dropped } = prepareProposalSlots(
      [allocatedX],
      [slot({ recipeId: 'y', participantIds: ['c'] })],
      ['a', 'b', 'c'],
    );
    expect(slots[0].portions).toBeUndefined();
    expect(dropped).toEqual([allocatedX]);
  });
});
