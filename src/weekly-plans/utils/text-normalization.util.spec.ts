import { ShoppingDepartment } from '../types/shopping-department.enum';
import { toShoppingDepartment } from './department-classifier.util';
import {
  escapeForRegex,
  keywordMatches,
  normalizeProductKey,
  toTitleCase,
} from './text-normalization.util';

// Tożsamość produktu na liście zakupów = `productKey`. Od plastra A nazwa
// z katalogu idzie na listę dosłownie, a klucz scala wyłącznie ten sam
// produkt w tej samej jednostce. Ten plik przybija te reguły na prawdziwych
// nazwach z katalogu (`prisma/catalog/ingredients-*.txt`), żeby żadna
// „poprawka" normalizacji nie mogła po cichu scalić fasoli z solą ani
// rozdzielić mąki na „mąka" i „Mąka".

describe('normalizeProductKey', () => {
  it('składa nazwę i jednostkę separatorem ::', () => {
    expect(normalizeProductKey('cebula', 'g')).toBe('cebula::g');
  });

  it('obcina i zmniejsza litery, ale ZACHOWUJE diakrytyki', () => {
    // Nazwy katalogu są kanoniczne i polskie — zdejmowanie ogonków tutaj
    // scaliłoby np. „mąka" z hipotetyczną „maka" i schowało literówkę.
    expect(normalizeProductKey('  Mąka pszenna ', ' G ')).toBe(
      'mąka pszenna::g',
    );
    expect(normalizeProductKey('sól', 'g')).not.toBe('sol::g');
  });

  it('ten sam produkt w innej jednostce to inny klucz', () => {
    expect(normalizeProductKey('sól', 'g')).not.toBe(
      normalizeProductKey('sól', 'ml'),
    );
  });
});

describe('toTitleCase', () => {
  it.each([
    ['cebula', 'Cebula'],
    ['ŁOSOŚ', 'ŁOSOŚ'],
    ['filet z kurczaka', 'Filet z kurczaka'],
    ['  masło ', 'Masło'],
    ['', ''],
    ['   ', ''],
  ])('%j -> %j', (input, expected) => {
    expect(toTitleCase(input)).toBe(expected);
  });
});

describe('keywordMatches', () => {
  it('traktuje słowo jako rdzeń z granicą na początku', () => {
    expect(keywordMatches('ser zolty', 'ser')).toBe(true);
    expect(keywordMatches('sery dojrzewajace', 'ser')).toBe(true);
    expect(keywordMatches('serce wolowe', 'ser')).toBe(true);
    expect(keywordMatches('konserwa', 'ser')).toBe(false);
    expect(keywordMatches('fasola z puszki', 'sol')).toBe(false);
  });

  it('escapeForRegex unieszkodliwia znaki specjalne', () => {
    expect(escapeForRegex('a.b*c?')).toBe('a\\.b\\*c\\?');
    // Bez escape'u kropka łapałaby dowolny znak: „205" przechodziłoby jako „2.5".
    expect(keywordMatches('cukier 2.5', '2.5')).toBe(true);
    expect(keywordMatches('cukier 205', '2.5')).toBe(false);
  });
});

// ─── Złota tabela: prawdziwe składniki katalogu ────────────────────────────────
//
// Kolumny: nazwa z `Ingredient.name`, jednostka po normalizacji, dział
// z pliku katalogu (`load-ingredient-catalog.ts` → `CATEGORY_BY_FILE`).
// Oczekiwania: klucz, nazwa wyświetlana, dział na liście.

type GoldenRow = {
  name: string;
  unit: 'g' | 'ml' | 'szt';
  category: string;
  productKey: string;
  display: string;
  department: ShoppingDepartment;
};

const GOLDEN: GoldenRow[] = [
  { name: 'sól', unit: 'g', category: 'Przyprawy i sosy', productKey: 'sól::g', display: 'Sól', department: ShoppingDepartment.SPICES },
  { name: 'pieprz czarny', unit: 'g', category: 'Przyprawy i sosy', productKey: 'pieprz czarny::g', display: 'Pieprz czarny', department: ShoppingDepartment.SPICES },
  { name: 'olej rzepakowy', unit: 'ml', category: 'Olej i tłuszcze', productKey: 'olej rzepakowy::ml', display: 'Olej rzepakowy', department: ShoppingDepartment.OILS },
  { name: 'cebula', unit: 'g', category: 'Warzywa', productKey: 'cebula::g', display: 'Cebula', department: ShoppingDepartment.VEGETABLES },
  { name: 'jajko', unit: 'szt', category: 'Nabiał', productKey: 'jajko::szt', display: 'Jajko', department: ShoppingDepartment.DAIRY },
  { name: 'czosnek', unit: 'szt', category: 'Warzywa', productKey: 'czosnek::szt', display: 'Czosnek', department: ShoppingDepartment.VEGETABLES },
  { name: 'masło', unit: 'g', category: 'Nabiał', productKey: 'masło::g', display: 'Masło', department: ShoppingDepartment.DAIRY },
  { name: 'ziemniak', unit: 'g', category: 'Warzywa', productKey: 'ziemniak::g', display: 'Ziemniak', department: ShoppingDepartment.VEGETABLES },
  { name: 'jogurt naturalny', unit: 'g', category: 'Nabiał', productKey: 'jogurt naturalny::g', display: 'Jogurt naturalny', department: ShoppingDepartment.DAIRY },
  { name: 'mąka pszenna', unit: 'g', category: 'Zboża i makarony', productKey: 'mąka pszenna::g', display: 'Mąka pszenna', department: ShoppingDepartment.GRAINS },
  { name: 'filet z kurczaka', unit: 'g', category: 'Mięso', productKey: 'filet z kurczaka::g', display: 'Filet z kurczaka', department: ShoppingDepartment.MEAT },
  { name: 'łosoś', unit: 'g', category: 'Ryby', productKey: 'łosoś::g', display: 'Łosoś', department: ShoppingDepartment.FISH },
  { name: 'banan', unit: 'szt', category: 'Owoce', productKey: 'banan::szt', display: 'Banan', department: ShoppingDepartment.FRUITS },
  { name: 'oliwa z oliwek', unit: 'ml', category: 'Olej i tłuszcze', productKey: 'oliwa z oliwek::ml', display: 'Oliwa z oliwek', department: ShoppingDepartment.OILS },
];

describe('tożsamość produktu — złota tabela katalogu', () => {
  it.each(GOLDEN.map((row) => [row.name, row] as const))(
    '%s',
    (_name, row) => {
      expect(normalizeProductKey(row.name, row.unit)).toBe(row.productKey);
      expect(toTitleCase(row.name)).toBe(row.display);
      expect(toShoppingDepartment(row.category)).toBe(row.department);
    },
  );

  it('żadne dwa wiersze nie zlewają się w jeden klucz', () => {
    const keys = GOLDEN.map((row) => normalizeProductKey(row.name, row.unit));
    expect(new Set(keys).size).toBe(GOLDEN.length);
  });
});
