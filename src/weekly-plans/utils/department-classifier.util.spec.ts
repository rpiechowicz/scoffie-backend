import { ShoppingDepartment } from '../types/shopping-department.enum';
import { toShoppingDepartment } from './department-classifier.util';

/**
 * Dział na liście zakupów to `RecipeIngredient.department` skopiowany
 * z `Ingredient.category` — etykiety katalogu są bajt w bajt wartościami
 * `ShoppingDepartment`. Ten test pilnuje, żeby żadna z nich nie przechodziła
 * przez heurystykę słów kluczowych (która potrafi przesunąć dział), a stare
 * etykiety i śmieci lądowały przewidywalnie.
 */
describe('toShoppingDepartment', () => {
  it('powinno przepuścić każdą etykietę katalogu bez zmian', () => {
    for (const label of Object.values(ShoppingDepartment)) {
      expect(toShoppingDepartment(label)).toBe(label);
    }
  });

  it('powinno zmapować stare etykiety spoza enumu po słowach kluczowych', () => {
    expect(toShoppingDepartment('Nabiał i jajko')).toBe(
      ShoppingDepartment.DAIRY,
    );
    expect(toShoppingDepartment('Ryby i owoce morza')).toBe(
      ShoppingDepartment.FISH,
    );
  });

  it('powinno zamienić pustą lub nieznaną etykietę na „Inne”', () => {
    expect(toShoppingDepartment('')).toBe(ShoppingDepartment.OTHER);
    expect(toShoppingDepartment(null)).toBe(ShoppingDepartment.OTHER);
    expect(toShoppingDepartment(undefined)).toBe(ShoppingDepartment.OTHER);
    expect(toShoppingDepartment('Zupełnie obca etykieta')).toBe(
      ShoppingDepartment.OTHER,
    );
  });
});
