import { RecipesCacheService } from './recipes-cache.service';
import {
  formatCatalogRevision,
  parseCatalogRevision,
} from './catalog-sync.service';

/**
 * Granice cache katalogu (workstream, Etap 4B) i token rewizji (4A).
 */
describe('RecipesCacheService — unieważnianie per dom', () => {
  const key = (cache: RecipesCacheService, householdId?: string) =>
    cache.buildRecipesListKey({
      userId: 'global',
      ...(householdId ? { householdId } : {}),
      page: 1,
      limit: 100,
    });

  it('zmiana przepisu JEDNEGO domu czyści tylko jego wpisy — wspólny katalog i inne domy zostają', () => {
    const cache = new RecipesCacheService();
    cache.set(key(cache), ['katalog']);
    cache.set(key(cache, 'dom-a'), ['a']);
    cache.set(key(cache, 'dom-b'), ['b']);

    cache.invalidateRecipesList('dom-a');

    expect(cache.get(key(cache, 'dom-a'))).toBeNull();
    expect(cache.get(key(cache, 'dom-b'))).toEqual(['b']);
    expect(cache.get(key(cache))).toEqual(['katalog']);
  });

  it('zmiana KATALOGU (bez domu) czyści całą listę', () => {
    const cache = new RecipesCacheService();
    cache.set(key(cache), ['katalog']);
    cache.set(key(cache, 'dom-a'), ['a']);
    cache.invalidateRecipesList();
    expect(cache.get(key(cache))).toBeNull();
    expect(cache.get(key(cache, 'dom-a'))).toBeNull();
  });
});

describe('token rewizji katalogu', () => {
  const epoch = '0b5e4d1c-3f2a-4b7c-9d8e-1a2b3c4d5e6f';

  it('epoka + numer, w obie strony', () => {
    const token = formatCatalogRevision(epoch, 12345678901234n);
    expect(token).toBe(`${epoch}.12345678901234`);
    expect(parseCatalogRevision(token)).toEqual({
      epoch,
      revision: 12345678901234n,
    });
  });

  it.each([
    undefined,
    '',
    'abc',
    `${epoch}`,
    `${epoch}.`,
    `${epoch}.-1`,
    'nie-uuid.5',
    42,
  ])('odrzuca %p', (value) => {
    expect(parseCatalogRevision(value)).toBeNull();
  });
});
