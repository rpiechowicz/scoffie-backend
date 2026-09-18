import { matchShoppingProduct } from './agent-tool-executor';

const items = [
  { productKey: 'mleko::ml', name: 'mleko' },
  { productKey: 'mleko-kokosowe::ml', name: 'mleko kokosowe' },
  { productKey: 'jajko::szt', name: 'jajka' },
  { productKey: 'maka-pszenna::g', name: 'mąka pszenna' },
  { productKey: 'ser-zolty::g', name: 'ser żółty' },
  { productKey: 'ser-bialy::g', name: 'ser biały' },
];

describe('matchShoppingProduct', () => {
  it('dokładna nazwa bije zawieranie', () => {
    // „mleko" ma trafić w mleko, a nie w mleko kokosowe tylko dlatego,
    // że tamto też zawiera to słowo.
    expect(matchShoppingProduct('mleko', items).matched?.productKey).toBe(
      'mleko::ml',
    );
  });

  it('łapie polską odmianę', () => {
    expect(matchShoppingProduct('jajko', items).matched?.productKey).toBe(
      'jajko::szt',
    );
    expect(matchShoppingProduct('mąki pszennej', items).matched?.name).toBe(
      'mąka pszenna',
    );
  });

  it('ogonki i wielkość liter nie mają znaczenia', () => {
    expect(matchShoppingProduct('MĄKA PSZENNA', items).matched?.name).toBe(
      'mąka pszenna',
    );
  });

  it('wieloznaczne NIE odhacza niczego', () => {
    // Odhaczenie nie tego sera jest ciche — nikt tego nie zauważy aż do sklepu.
    const result = matchShoppingProduct('ser', items);
    expect(result.matched).toBeNull();
    expect(result.ambiguous).toEqual(['ser biały', 'ser żółty']);
  });

  it('czego nie ma na liście, tego nie dopasowuje', () => {
    const result = matchShoppingProduct('szynka', items);
    expect(result.matched).toBeNull();
    expect(result.ambiguous).toEqual([]);
  });

  it('pusta nazwa nie trafia w pierwszą lepszą pozycję', () => {
    expect(matchShoppingProduct('   ', items).matched).toBeNull();
  });
});
