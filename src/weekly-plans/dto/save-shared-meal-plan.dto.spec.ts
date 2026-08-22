import { MealType } from '@prisma/client';
import {
  SaveSharedMealPlanDto,
  mergeSharedPlanRecipeIds,
  sharedPlanAddressedMealTypes,
} from './save-shared-meal-plan.dto';

function dto(partial: Partial<SaveSharedMealPlanDto>): SaveSharedMealPlanDto {
  return Object.assign(new SaveSharedMealPlanDto(), partial);
}

describe('mergeSharedPlanRecipeIds', () => {
  it('czyta stare pola, gdy nie ma nowej mapy', () => {
    const merged = mergeSharedPlanRecipeIds(
      dto({ breakfastRecipeIds: ['a'], lunchRecipeIds: ['b'], dinnerRecipeIds: ['c'] }),
    );

    expect(merged[MealType.BREAKFAST]).toEqual(['a']);
    expect(merged[MealType.LUNCH]).toEqual(['b']);
    expect(merged[MealType.DINNER]).toEqual(['c']);
    expect(merged[MealType.SECOND_BREAKFAST]).toEqual([]);
  });

  it('nowa mapa wygrywa nad starymi polami dla slotów, które wymienia', () => {
    const merged = mergeSharedPlanRecipeIds(
      dto({
        breakfastRecipeIds: ['stare'],
        recipeIdsByMealType: { [MealType.BREAKFAST]: ['nowe'] },
      }),
    );

    expect(merged[MealType.BREAKFAST]).toEqual(['nowe']);
  });

  it('stare pole zostaje, gdy nowa mapa go nie wymienia', () => {
    const merged = mergeSharedPlanRecipeIds(
      dto({
        lunchRecipeIds: ['obiad'],
        recipeIdsByMealType: { [MealType.SNACK]: ['przekaska'] },
      }),
    );

    expect(merged[MealType.LUNCH]).toEqual(['obiad']);
    expect(merged[MealType.SNACK]).toEqual(['przekaska']);
  });
});

describe('sharedPlanAddressedMealTypes', () => {
  // Regresja: zapis ze starszej aplikacji kasował dodatkowe posiłki
  // zaplanowane z nowszej. Wystarczyło, że jeden domownik zaktualizował
  // aplikację, a drugi nie — i podwieczorek znikał bez błędu.
  it('żądanie bez nowej mapy dotyczy wyłącznie trójki obowiązkowej', () => {
    const addressed = sharedPlanAddressedMealTypes(
      dto({ breakfastRecipeIds: ['a'], lunchRecipeIds: [], dinnerRecipeIds: [] }),
    );

    expect(addressed).toEqual([MealType.BREAKFAST, MealType.LUNCH, MealType.DINNER]);
    expect(addressed).not.toContain(MealType.SECOND_BREAKFAST);
    expect(addressed).not.toContain(MealType.AFTERNOON_SNACK);
    expect(addressed).not.toContain(MealType.SNACK);
  });

  it('pusta mapa to nadal deklaracja „mówię o wszystkich slotach"', () => {
    // Nowy klient, który wyczyścił całą pulę, wysyła `{}` — i musi mieć
    // możliwość skasowania wszystkiego, łącznie z dodatkowymi posiłkami.
    expect(sharedPlanAddressedMealTypes(dto({ recipeIdsByMealType: {} }))).toHaveLength(6);
  });

  it('mapa razem ze starymi polami też dotyczy wszystkich slotów', () => {
    const addressed = sharedPlanAddressedMealTypes(
      dto({
        breakfastRecipeIds: ['a'],
        recipeIdsByMealType: { [MealType.BREAKFAST]: ['a'] },
      }),
    );

    expect(addressed).toHaveLength(6);
  });

  it('zwraca sloty w kolejności dnia', () => {
    expect(sharedPlanAddressedMealTypes(dto({ recipeIdsByMealType: {} }))).toEqual([
      MealType.BREAKFAST,
      MealType.SECOND_BREAKFAST,
      MealType.LUNCH,
      MealType.AFTERNOON_SNACK,
      MealType.DINNER,
      MealType.SNACK,
    ]);
  });
});
