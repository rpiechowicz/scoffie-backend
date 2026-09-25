import { readFileSync } from 'fs';
import { join } from 'path';
import { resolveSuitableMealTypes } from '../suitable-meal-types.util';
import {
  buildCatalogFile,
  CATALOG_EXPORT_VERSION,
  catalogEntryFromColumns,
  catalogEntryFromRow,
  describeCatalogDiff,
  diffCatalog,
  formatCatalogFile,
  importGuard,
  summarizeCatalogDiff,
  withCanonicalKeyOrder,
  type CatalogEntrySource,
} from './catalog-export';
import {
  CATALOG_FILE_PATH,
  catalogRecipeColumns,
  CatalogRecipeError,
  resolveCatalogIngredients,
  validateCatalogRecipe,
  type CatalogFile,
  type CatalogIngredientLookup,
  type CatalogIngredientRef,
  type CatalogRecipeInput,
} from './catalog-recipe';

const ref = (
  name: string,
  normalizedName: string,
  extra: Partial<CatalogIngredientRef> = {},
): CatalogIngredientRef => ({
  id: `id-${normalizedName}`,
  name,
  normalizedName,
  category: 'Nabiał i jajko',
  allergens: [],
  dietTags: [],
  nutrition: {
    kcal: 100,
    protein: 10,
    carbs: 10,
    fat: 1,
    fiber: 1,
    sodiumMg: 0,
    gramsPerPiece: 50,
  },
  ...extra,
});

const lookup: CatalogIngredientLookup = new Map([
  [
    'mleko',
    ref('mleko', 'mleko', { allergens: ['milk'], dietTags: ['DAIRY'] }),
  ],
  ['platki owsiane', ref('płatki owsiane', 'platki owsiane')],
  // Alias: nazwa z pliku → składnik kanoniczny.
  ['owsianka platki', ref('płatki owsiane', 'platki owsiane')],
  ['jajko', ref('jajko', 'jajko', { allergens: ['eggs'] })],
]);

const base: CatalogRecipeInput = {
  id: '0b8f6a4e-3f1c-4b6e-9d2a-1c2b3d4e5f60',
  title: 'Owsianka na mleku',
  description: 'Kremowa owsianka.',
  mealType: 'BREAKFAST',
  difficulty: 'EASY',
  prepTimeMinutes: 10,
  servings: 2,
  nutrition: {
    kcal: 600,
    protein: 20,
    carbs: 90,
    fat: 12,
    fiber: 8,
    salt: 0.4,
    addedSalt: 0,
  },
  steps: [
    { step: 1, instruction: 'Zagotuj mleko.' },
    { step: 2, instruction: 'Wsyp płatki i gotuj 5 minut.' },
  ],
  ingredients: [
    { ingredientName: 'mleko', amount: 400, unit: 'ml' },
    { ingredientName: 'płatki owsiane', amount: 100, unit: 'g' },
  ],
  image: {
    prompt: 'Owsianka w misce',
    imageUrl: 'https://img.scoffie.app/recipe-images/x.webp',
  },
};

/** Zapis w locie: co trafiłoby do bazy i co wyszłoby z eksportu. */
function roundTrip(entry: CatalogRecipeInput): CatalogRecipeInput {
  const rows = resolveCatalogIngredients(entry, lookup);
  const columns = catalogRecipeColumns(entry, rows);
  return catalogEntryFromColumns(
    entry.id!,
    columns,
    rows,
    entry.image.imageUrl,
  );
}

describe('eksport katalogu', () => {
  describe('format pliku', () => {
    it('obiekty rozpisane, krótkie tablice w linii, LF i nowa linia na końcu', () => {
      const text = formatCatalogFile({
        version: 'v',
        recipes: [
          { ...base, suitableMealTypes: ['BREAKFAST', 'SECOND_BREAKFAST'] },
        ],
      });
      expect(text.endsWith('}\n')).toBe(true);
      expect(text).not.toContain('\r');
      expect(text).toContain(
        '      "suitableMealTypes": ["BREAKFAST", "SECOND_BREAKFAST"],\n',
      );
      expect(text).toContain('      "nutrition": {\n        "kcal": 600,\n');
      expect(text).toContain('        "salt": 0.4,\n');
      expect(JSON.parse(text)).toEqual({
        version: 'v',
        recipes: [
          { ...base, suitableMealTypes: ['BREAKFAST', 'SECOND_BREAKFAST'] },
        ],
      });
    });

    it('tablica ponad 80 kolumn — element pod elementem (jak prettier)', () => {
      const text = formatCatalogFile({
        version: 'v',
        recipes: [
          {
            ...base,
            suitableMealTypes: [
              'BREAKFAST',
              'SECOND_BREAKFAST',
              'LUNCH',
              'AFTERNOON_SNACK',
              'DINNER',
            ],
          },
        ],
      });
      expect(text).toContain(
        '      "suitableMealTypes": [\n        "BREAKFAST",\n        "SECOND_BREAKFAST",\n',
      );
    });

    it('kolejność: pora dnia, potem tytuł po polsku, remis po id', () => {
      const entries = [
        { ...base, id: 'c', title: 'Łosoś', mealType: 'LUNCH' as const },
        { ...base, id: 'b', title: 'Zupa', mealType: 'BREAKFAST' as const },
        { ...base, id: 'a', title: 'Lody', mealType: 'LUNCH' as const },
        { ...base, id: 'd', title: 'Ananas', mealType: 'DINNER' as const },
      ];
      expect(buildCatalogFile(entries).recipes.map((r) => r.id)).toEqual([
        'b',
        'a',
        'c',
        'd',
      ]);
      expect(buildCatalogFile(entries).version).toBe(CATALOG_EXPORT_VERSION);
    });
  });

  describe('wiersz → wpis', () => {
    const row = (
      over: Partial<CatalogEntrySource> = {},
    ): CatalogEntrySource => ({
      id: base.id!,
      isActive: true,
      title: base.title,
      description: base.description,
      mealType: 'BREAKFAST',
      suitableMealTypes: ['BREAKFAST', 'SECOND_BREAKFAST'],
      difficulty: 'EASY',
      prepTimeMinutes: 10,
      servings: 2,
      nutritionKcal: 600,
      nutritionProtein: 20,
      nutritionCarbs: 90,
      nutritionFat: 12,
      nutritionFiber: 8,
      nutritionSalt: 0.4,
      nutritionSaltAdded: 0,
      sourceProvider: 'manual-json-v1',
      sourceRecipeId: null,
      sourceInstructions: [
        { step: 2, text: 'Wsyp płatki.' },
        { step: 1, text: ' Zagotuj mleko. ' },
        { step: 3, text: '  ' },
      ],
      sourceMeta: { imagePrompt: 'Owsianka' },
      imageUrl: null,
      ingredients: [
        { amount: 400, unit: 'ml', ingredient: { name: 'mleko' } },
        { amount: 100, unit: 'g', ingredient: { name: 'płatki owsiane' } },
      ],
      ...over,
    });

    it('klucze w kanonicznej kolejności, kroki od 1, domyślny dostawca pominięty', () => {
      const entry = catalogEntryFromRow(row());
      expect(Object.keys(entry)).toEqual([
        'id',
        'title',
        'description',
        'mealType',
        'suitableMealTypes',
        'difficulty',
        'prepTimeMinutes',
        'servings',
        'nutrition',
        'steps',
        'ingredients',
        'image',
      ]);
      expect(entry.steps).toEqual([
        { step: 1, instruction: 'Zagotuj mleko.' },
        { step: 2, instruction: 'Wsyp płatki.' },
      ]);
      expect(entry.image).toEqual({ prompt: 'Owsianka', imageUrl: null });
    });

    it('wycofany ma `isActive: false` zaraz po id; źródło zewnętrzne zostaje', () => {
      const entry = catalogEntryFromRow(
        row({
          isActive: false,
          sourceProvider: 'cookidoo',
          sourceRecipeId: 'r1',
        }),
      );
      expect(Object.keys(entry).slice(0, 3)).toEqual([
        'id',
        'isActive',
        'title',
      ]);
      expect(entry.isActive).toBe(false);
      expect(entry).toMatchObject({
        sourceProvider: 'cookidoo',
        sourceRecipeId: 'r1',
      });
      expect(withCanonicalKeyOrder(entry)).toEqual(entry);
      expect(Object.keys(withCanonicalKeyOrder(entry))).toEqual(
        Object.keys(entry),
      );
    });

    it('pusta lista slotów (wiersz sprzed backfillu) = slot bazowy', () => {
      expect(
        catalogEntryFromRow(row({ suitableMealTypes: [] })).suitableMealTypes,
      ).toEqual(['BREAKFAST']);
    });
  });

  describe('obieg wpis → kolumny → wpis', () => {
    const canonical = (entry: CatalogRecipeInput): CatalogRecipeInput => ({
      ...entry,
      suitableMealTypes: resolveSuitableMealTypes({
        title: entry.title,
        description: entry.description,
        mealType: entry.mealType,
        prepTimeMinutes: entry.prepTimeMinutes,
        servings: entry.servings,
        nutritionKcal: entry.nutrition.kcal,
        suitableMealTypes: entry.suitableMealTypes,
      }),
    });

    it('wpis w formacie eksportu wraca bez zmian (bajt w bajt)', () => {
      const entries = [
        canonical(base),
        canonical({ ...base, suitableMealTypes: ['BREAKFAST', 'DINNER'] }),
        canonical({
          ...base,
          isActive: false,
          sourceProvider: 'cookidoo',
          sourceRecipeId: 'r56899',
        }),
      ];
      for (const entry of entries) {
        const back = roundTrip(entry);
        expect(formatCatalogFile({ version: 'v', recipes: [back] })).toBe(
          formatCatalogFile({ version: 'v', recipes: [entry] }),
        );
      }
    });

    it('alias w pliku → nazwa kanoniczna; tagi z unii składników', () => {
      const entry = canonical({
        ...base,
        ingredients: [
          { ingredientName: 'owsianka płatki', amount: 100, unit: 'g' },
          { ingredientName: 'jajko', amount: 2, unit: 'szt' },
        ],
      });
      const rows = resolveCatalogIngredients(entry, lookup);
      const columns = catalogRecipeColumns(entry, rows);
      expect(columns.allergens).toEqual(['eggs']);
      expect(roundTrip(entry).ingredients[0].ingredientName).toBe(
        'płatki owsiane',
      );
    });

    it('zły składnik i dwa razy ten sam — jeden błąd z listą', () => {
      expect(() =>
        resolveCatalogIngredients(
          {
            title: 'x',
            ingredients: [
              { ingredientName: 'kamień', amount: 1, unit: 'g' },
              { ingredientName: 'mleko', amount: 1, unit: 'ml' },
              { ingredientName: 'Mleko', amount: 2, unit: 'ml' },
            ],
          },
          lookup,
        ),
      ).toThrow(CatalogRecipeError);
      try {
        resolveCatalogIngredients(
          {
            title: 'x',
            ingredients: [
              { ingredientName: 'kamień', amount: 1, unit: 'g' },
              { ingredientName: 'mleko', amount: 1, unit: 'ml' },
              { ingredientName: 'Mleko', amount: 2, unit: 'ml' },
            ],
          },
          lookup,
        );
      } catch (error) {
        expect((error as CatalogRecipeError).details).toEqual([
          'nieznany składnik: kamień',
          'składnik dwa razy: mleko',
        ]);
      }
    });

    it('walidacja: porcje 1..8, jednostka z listy, niepuste kroki', () => {
      expect(validateCatalogRecipe(base)).toEqual([]);
      expect(
        validateCatalogRecipe({
          ...base,
          servings: 9,
          steps: [{ step: 1, instruction: '  ' }],
          ingredients: [{ ingredientName: 'mleko', amount: 1, unit: 'kubek' }],
        }),
      ).toHaveLength(3);
    });
  });

  describe('różnice', () => {
    it('dodane, zmienione (lista pól), wycofane, usunięte', () => {
      const a = { ...base, id: 'a', title: 'A' };
      const b = { ...base, id: 'b', title: 'B' };
      const c = { ...base, id: 'c', title: 'C' };
      const diff = diffCatalog(
        [a, b, c],
        [
          { ...a, servings: 4 },
          { ...b, isActive: false },
          { ...base, id: 'd', title: 'D' },
        ],
      );
      expect(diff.added.map((x) => x.id)).toEqual(['d']);
      expect(diff.changed).toEqual([
        { id: 'a', title: 'A', fields: ['servings'] },
      ]);
      expect(diff.retired.map((x) => x.id)).toEqual(['b']);
      expect(diff.removed.map((x) => x.id)).toEqual(['c']);
      expect(summarizeCatalogDiff(diff)).toBe(
        'zmienione 1, dodane 1, wycofane 1, usunięte 1',
      );
      expect(describeCatalogDiff(diff)).toContain('- A [servings]');
    });

    it('kolejność składników: różnica, chyba że ignoreIngredientOrder', () => {
      const swapped = {
        ...base,
        ingredients: [...base.ingredients].reverse(),
      };
      expect(diffCatalog([base], [swapped]).changed).toHaveLength(1);
      expect(
        diffCatalog([base], [swapped], { ignoreIngredientOrder: true }).changed,
      ).toHaveLength(0);
    });
  });

  describe('strażnik importu', () => {
    const now = new Date('2026-09-25T10:00:00Z');
    const a = { ...base, id: 'a', title: 'A' };
    const b = { ...base, id: 'b', title: 'B' };

    it('nowe przepisy z pliku przechodzą bez potwierdzenia', () => {
      // diffCatalog(plik, baza): `b` jest tylko w pliku.
      const guard = importGuard(diffCatalog([a, b], [a]), undefined, now);
      expect(guard).toMatchObject({ allowed: true, count: 0 });
    });

    it('zmiana, wycofanie albo przepis tylko w bazie — odmowa bez daty', () => {
      for (const database of [
        [{ ...a, servings: 4 }],
        [{ ...a, isActive: false }],
        [a, b],
      ]) {
        const guard = importGuard(diffCatalog([a], database), '', now);
        expect(guard.allowed).toBe(false);
        expect(guard.count).toBeGreaterThan(0);
      }
    });

    it('dzisiejsza data odblokowuje, wczorajsza nie', () => {
      const diff = diffCatalog([a], [{ ...a, servings: 4 }]);
      expect(importGuard(diff, '2026-09-25', now)).toMatchObject({
        allowed: true,
        confirmed: true,
      });
      expect(importGuard(diff, '2026-09-24', now).allowed).toBe(false);
    });
  });

  describe('plik w repo', () => {
    const raw = readFileSync(
      join(__dirname, '..', '..', '..', CATALOG_FILE_PATH),
      'utf8',
    );
    const file = JSON.parse(raw) as CatalogFile;

    it('jest w formacie eksportu (kolejność, klucze, układ) — `pnpm catalog:export` nic by nie zmienił w układzie', () => {
      expect(file.version).toBe(CATALOG_EXPORT_VERSION);
      expect(
        formatCatalogFile(
          buildCatalogFile(file.recipes.map(withCanonicalKeyOrder)),
        ),
      ).toBe(raw);
    });

    it('każdy przepis przechodzi walidację importu', () => {
      expect(file.recipes.flatMap(validateCatalogRecipe)).toEqual([]);
    });
  });
});
