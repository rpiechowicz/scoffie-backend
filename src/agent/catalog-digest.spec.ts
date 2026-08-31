import {
  buildCatalogDigest,
  buildDigestLine,
  DIGEST_HEADER,
  DigestIngredient,
  DigestRecipe,
} from './catalog-digest';

const ingredient = (
  name: string,
  normalizedAmount: number,
  normalizedUnit = 'g',
  gramsPerPiece: number | null = null,
): DigestIngredient => ({
  name,
  normalizedAmount,
  normalizedUnit,
  gramsPerPiece,
});

const recipe = (overrides: Partial<DigestRecipe> = {}): DigestRecipe => ({
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Leczo z kiełbasą',
  mealType: 'LUNCH',
  suitableMealTypes: ['LUNCH', 'DINNER'],
  prepTimeMinutes: 35,
  servings: 2,
  // Jak w bazie: wartości dla CAŁEGO przepisu.
  nutritionKcal: 1392,
  nutritionProtein: 76,
  nutritionFat: 38,
  nutritionCarbs: 84,
  ingredients: [
    ingredient('pomidor krojony z puszki', 500),
    ingredient('przyprawa uniwersalna', 5),
    ingredient('papryka czerwona', 450),
    ingredient('sól', 6),
    ingredient('cukinia', 300),
    ingredient('kiełbasa śląska', 250),
    ingredient('cebula', 150),
    ingredient('pieprz czarny', 1),
  ],
  ...overrides,
});

describe('buildDigestLine', () => {
  it('podaje makro NA PORCJĘ, nie na cały przepis', () => {
    const line = buildDigestLine(recipe(), 'R07');
    // 1392/2 = 696; bez dzielenia asystent widziałby obiad na 1392 kcal
    // i uznałby go za niemożliwy do wpisania w dzienny cel.
    expect(line).toContain('696kcal P38 F19 C42');
  });

  it('servings 0 nie dzieli przez zero', () => {
    const line = buildDigestLine(recipe({ servings: 0 }), 'R01');
    expect(line).toContain('1392kcal');
    expect(line).toContain('|1p|');
  });

  it('wybiera 5 NAJCIĘŻSZYCH składników, nie pierwsze z brzegu', () => {
    const line = buildDigestLine(recipe(), 'R07');
    const składniki = line.split('|')[6];
    expect(składniki).toBe(
      'pomidor krojony z puszki, papryka czerwona, cukinia, kiełbasa śląska, cebula',
    );
    // Przyprawy nie niosą informacji o daniu — a to one wypadały pierwsze
    // przy kolejności z bazy (wszystkie mają ten sam `createdAt`).
    expect(składniki).not.toContain('sól');
    expect(składniki).not.toContain('pieprz');
  });

  it('przelicza sztuki na gramy po `gramsPerPiece`', () => {
    const line = buildDigestLine(
      recipe({
        ingredients: [
          ingredient('mąka', 200),
          ingredient('jajko', 4, 'szt', 60), // 240 g — cięższe niż mąka
        ],
      }),
      'R01',
    );
    expect(line.split('|')[6]).toBe('jajko, mąka');
  });

  it('sztuki bez gramatury dostają wagę zastępczą', () => {
    const line = buildDigestLine(
      recipe({
        ingredients: [
          ingredient('mąka', 150),
          ingredient('bułka', 2, 'szt', null), // 2 × 100 g
        ],
      }),
      'R01',
    );
    expect(line.split('|')[6]).toBe('bułka, mąka');
  });

  it('remis rozstrzyga nazwa — ten sam katalog daje ten sam bajt', () => {
    const równe = recipe({
      ingredients: [
        ingredient('ziemniaki', 300),
        ingredient('marchew', 300),
        ingredient('burak', 300),
      ],
    });
    expect(buildDigestLine(równe, 'R01').split('|')[6]).toBe(
      'burak, marchew, ziemniaki',
    );
  });

  it('puste suitableMealTypes czyta się jak [mealType]', () => {
    const line = buildDigestLine(
      recipe({ mealType: 'BREAKFAST', suitableMealTypes: [] }),
      'R01',
    );
    expect(line.split('|')[2]).toBe('BREAKFAST');
  });

  it('linia ma dokładnie 7 pól — inaczej model nie rozczyta formatu', () => {
    expect(buildDigestLine(recipe(), 'R07').split('|')).toHaveLength(7);
  });
});

describe('buildCatalogDigest', () => {
  const many = (count: number): DigestRecipe[] =>
    Array.from({ length: count }, (_unused, i) =>
      recipe({
        id: `id-${i}`,
        title: `Przepis ${i}`,
      }),
    );

  it('zaczyna się nagłówkiem i ma po jednej linii na przepis', () => {
    const digest = buildCatalogDigest(many(3));
    expect(digest.text.startsWith(DIGEST_HEADER)).toBe(true);
    expect(digest.text.split('\n')).toHaveLength(
      DIGEST_HEADER.split('\n').length + 3,
    );
    expect(digest.recipeCount).toBe(3);
  });

  it('mapuje indeks na recipeId — jedyna droga od modelu do bazy', () => {
    const digest = buildCatalogDigest(many(3));
    expect(digest.index).toEqual({
      R01: 'id-0',
      R02: 'id-1',
      R03: 'id-2',
    });
  });

  it('szerokość indeksu rośnie z katalogiem', () => {
    expect(Object.keys(buildCatalogDigest(many(9)).index)[0]).toBe('R01');
    expect(Object.keys(buildCatalogDigest(many(100)).index)[0]).toBe('R001');
  });

  it('nie zawiera UUID-ów — to była jedna czwarta digestu za nic', () => {
    const digest = buildCatalogDigest([recipe()]);
    expect(digest.text).not.toContain('11111111-1111-4111-8111-111111111111');
  });

  it('catalogVersion jest stabilny dla tego samego katalogu', () => {
    expect(buildCatalogDigest(many(5)).catalogVersion).toBe(
      buildCatalogDigest(many(5)).catalogVersion,
    );
  });

  it('catalogVersion zmienia się, gdy zmieni się treść', () => {
    const before = buildCatalogDigest(many(5)).catalogVersion;
    const after = buildCatalogDigest([
      ...many(5),
      recipe({ id: 'nowy', title: 'Nowy przepis' }),
    ]).catalogVersion;
    expect(after).not.toBe(before);
  });

  it('pusty katalog daje sam nagłówek, bez wywrotki', () => {
    const digest = buildCatalogDigest([]);
    expect(digest.text).toBe(DIGEST_HEADER);
    expect(digest.recipeCount).toBe(0);
    expect(digest.index).toEqual({});
  });
});
