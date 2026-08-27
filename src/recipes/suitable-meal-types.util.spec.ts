import { MealType } from '@prisma/client';
import { OPTIONAL_MEAL_TYPES } from '../common/meal-types';
import {
  resolveSuitableMealTypes,
  suggestExtraMealTypes,
  type SuitabilityInput,
} from './suitable-meal-types.util';

/**
 * Ten plik jest siatką bezpieczeństwa pod klasyfikator slotów. Reguły
 * opierają się na markerach tekstowych, więc każde dołożenie słowa do listy
 * potrafi po cichu przesunąć danie do slotu, w którym nie ma sensu. Dlatego
 * fixture niżej to **prawdziwy katalog** z bazy (tytuł, opis, czas, porcje,
 * kcal — 1:1), a nie wymyślone przykłady: jeśli zmiana w markerach ruszy
 * którekolwiek danie, test to pokaże z nazwy.
 *
 * Dokładając marker: dopisz przepis do `CATALOGUE` albo popraw oczekiwanie
 * i zobacz w diffie, co dokładnie się przesunęło.
 */

type CatalogueEntry = {
  title: string;
  description: string;
  mealType: MealType;
  prepTimeMinutes: number;
  servings: number;
  nutritionKcal: number;
  expected: MealType[];
};

const B = MealType.BREAKFAST;
const SB = MealType.SECOND_BREAKFAST;
const L = MealType.LUNCH;
const AS = MealType.AFTERNOON_SNACK;
const D = MealType.DINNER;
const S = MealType.SNACK;

const CATALOGUE: CatalogueEntry[] = [
  {
    title: 'Jajecznica ze szczypiorkiem i pomidorem',
    description:
      'Klasyczna jajecznica z masłem i świeżym szczypiorkiem. Prosty pomidor z boku dodaje świeżości i równoważy smak.',
    mealType: B,
    prepTimeMinutes: 10,
    servings: 2,
    nutritionKcal: 579,
    expected: [B, SB, S],
  },
  {
    title: 'Jogurt naturalny z musli i jabłkiem',
    description:
      'Szybkie śniadanie na zimno z jogurtem naturalnym, chrupiącym dodatkiem i jabłkiem. Lekkie, ale dobrze sycące na poranek.',
    mealType: B,
    prepTimeMinutes: 6,
    servings: 2,
    nutritionKcal: 677,
    expected: [B, SB, AS, S],
  },
  {
    title: 'Kanapka z twarożkiem i ogórkiem',
    description:
      'Świeża kanapka z kremowym twarożkiem i chrupiącym ogórkiem. To lekkie śniadanie, które robi się w kilka minut.',
    mealType: B,
    prepTimeMinutes: 8,
    servings: 2,
    nutritionKcal: 619,
    // Wytrawna — na podwieczorek nie schodzi, mimo twarożku.
    expected: [B, SB, S],
  },
  {
    title: 'Naleśniki z twarożkiem i truskawkami',
    description:
      'Delikatne naleśniki z kremowym twarożkiem i świeżymi truskawkami. Klasyczne śniadanie na słodko, które zawsze się sprawdza.',
    mealType: B,
    prepTimeMinutes: 28,
    servings: 2,
    nutritionKcal: 1176,
    expected: [B],
  },
  {
    title: 'Omlet ze szpinakiem i fetą',
    description:
      'Puszysty omlet z dodatkiem szpinaku i sera feta. Smak jest wyraźny, a przygotowanie zajmuje tylko chwilę.',
    mealType: B,
    prepTimeMinutes: 12,
    servings: 2,
    nutritionKcal: 786,
    expected: [B, SB],
  },
  {
    title: 'Owsianka z bananem i borówką',
    description:
      'Kremowa owsianka na mleku z dodatkiem banana i borówki. Śniadanie jest szybkie, sycące i dobre na codzienny start.',
    mealType: B,
    prepTimeMinutes: 12,
    servings: 2,
    nutritionKcal: 894,
    expected: [B, SB],
  },
  {
    title: 'Placuszki owsiane z jogurtem i owocami',
    description:
      'Miękkie placuszki owsiane z jogurtem naturalnym i świeżymi owocami. To sycące śniadanie na słodko bez dużego wysiłku.',
    mealType: B,
    prepTimeMinutes: 20,
    servings: 2,
    nutritionKcal: 911,
    expected: [B, SB],
  },
  {
    title: 'Szakszuka z papryką i cebulą',
    description:
      'Jajka duszone w gęstym pomidorowym sosie z papryką i cebulą. To śniadanie jest wyraziste, ale nadal proste do zrobienia.',
    mealType: B,
    prepTimeMinutes: 22,
    servings: 2,
    nutritionKcal: 557,
    expected: [B],
  },
  {
    title: 'Tortilla śniadaniowa z jajkiem i serem',
    description:
      'Ciepła tortilla z jajkiem, serem i warzywami to szybkie śniadanie na wynos lub do zjedzenia w domu. Smak jest łagodny i bardzo uniwersalny.',
    mealType: B,
    prepTimeMinutes: 15,
    servings: 2,
    nutritionKcal: 1103,
    expected: [B],
  },
  {
    title: 'Tost z awokado i jajkiem',
    description:
      'Chrupiący tost z kremowym awokado i jajkiem sadzonym. To proste śniadanie, które syci i dobrze smakuje o każdej porze dnia.',
    mealType: B,
    prepTimeMinutes: 14,
    servings: 2,
    nutritionKcal: 931,
    expected: [B, SB],
  },
  {
    title: 'Jajka sadzone z ziemniakami i mizerią',
    description:
      'Klasyczny, prosty zestaw na ciepłą kolację: jajka sadzone, ziemniaki i mizeria. Smak domowy i dobrze znany.',
    mealType: D,
    prepTimeMinutes: 28,
    servings: 2,
    nutritionKcal: 843,
    expected: [D],
  },
  {
    title: 'Kanapki na ciepło z mozzarellą i pomidorem',
    description:
      'Szybkie kanapki na ciepło z roztopioną mozzarellą i pomidorem. Świetna kolacja, gdy chcesz zjeść coś prostego i smacznego.',
    mealType: D,
    prepTimeMinutes: 14,
    servings: 2,
    nutritionKcal: 912,
    // Mieści się we wszystkich progach — trzyma ją wyłącznie „na ciepło".
    expected: [D],
  },
  {
    title: 'Klopsiki z indyka w sosie pomidorowym z ryżem',
    description:
      'Delikatne klopsiki z indyka w prostym sosie pomidorowym, podane z ryżem. To sycąca i bardzo praktyczna kolacja.',
    mealType: D,
    prepTimeMinutes: 38,
    servings: 2,
    nutritionKcal: 1242,
    expected: [D],
  },
  {
    title: 'Krem z pomidorów z grzankami',
    description:
      'Gładki krem z pomidorów z chrupiącymi grzankami to lekka i bardzo przyjemna kolacja. Smak jest prosty, ale wyrazisty.',
    mealType: D,
    prepTimeMinutes: 26,
    servings: 2,
    nutritionKcal: 704,
    expected: [D],
  },
  {
    title: 'Kurczak w sosie śmietanowym z ryżem',
    description:
      'Delikatny kurczak w kremowym sosie śmietanowym podany z ryżem. Danie jest sycące i bardzo lubiane w domowej kuchni.',
    mealType: D,
    prepTimeMinutes: 30,
    servings: 2,
    nutritionKcal: 1339,
    expected: [D],
  },
  {
    title: 'Makaron z tuńczykiem i passatą pomidorową',
    description:
      'Makaron z tuńczykiem w lekkim sosie pomidorowym to szybka i wygodna kolacja. Danie jest proste, a jednocześnie sycące.',
    mealType: D,
    prepTimeMinutes: 24,
    servings: 2,
    nutritionKcal: 1095,
    expected: [D],
  },
  {
    title: 'Ryż smażony z jajkiem i warzywami',
    description:
      'Szybki ryż smażony z jajkiem i warzywami to świetny sposób na prostą kolację. Smak jest wyrazisty, a przygotowanie zajmuje niewiele czasu.',
    mealType: D,
    prepTimeMinutes: 22,
    servings: 2,
    nutritionKcal: 1043,
    expected: [D],
  },
  {
    title: 'Sałatka grecka z pieczywem',
    description:
      'Prosta sałatka w stylu greckim z pieczywem, dobra na lekką kolację. Świeże warzywa i feta dają wyrazisty, ale przyjemny smak.',
    mealType: D,
    prepTimeMinutes: 14,
    servings: 2,
    nutritionKcal: 836,
    // Świadomie awansowana: zimna, przenośna, mieści się w 480 kcal/porcja.
    expected: [SB, D],
  },
  {
    title: 'Tosty z szynką i serem',
    description:
      'Ciepłe tosty z szynką i ciągnącym się serem to szybka kolacja lub sycące śniadanie. Proste składniki i bardzo dobry efekt.',
    mealType: D,
    prepTimeMinutes: 12,
    servings: 2,
    nutritionKcal: 1042,
    // UWAGA: trzyma je tylko próg 480 kcal (521/porcja), nie marker — „ciepłe
    // tosty" nie zawiera frazy „na ciepło". Gdyby ktoś podniósł próg albo
    // dodał lżejszą wersję, ten przypadek wróci jako fałszywy pozytyw.
    expected: [D],
  },
  {
    title: 'Zapiekanka ziemniaczana z kurczakiem i serem',
    description:
      'Warstwowa zapiekanka ziemniaczana z kurczakiem i serem to sycąca kolacja dla dwóch osób. Danie jest proste, a efekt bardzo satysfakcjonujący.',
    mealType: D,
    prepTimeMinutes: 45,
    servings: 2,
    nutritionKcal: 1664,
    expected: [D],
  },
  {
    title: 'Sałatka z kurczakiem i fetą',
    description:
      'Lekka sałatka z kurczakiem, fetą i świeżymi warzywami. To szybki obiad, gdy chcesz zjeść coś lżejszego.',
    mealType: L,
    prepTimeMinutes: 20,
    servings: 2,
    nutritionKcal: 736,
    // Lekka i przenośna, ale obiad nie awansuje — inaczej plan tygodnia
    // podsuwałby obiady na II śniadanie.
    expected: [L],
  },
  {
    title: 'Zupa pomidorowa z ryżem',
    description:
      'Klasyczna zupa pomidorowa z ryżem, gęsta i delikatnie kremowa. To prosty obiad, który smakuje całej rodzinie.',
    mealType: L,
    prepTimeMinutes: 30,
    servings: 2,
    nutritionKcal: 813,
    expected: [L],
  },
  {
    title: 'Kurczak curry z ryżem',
    description:
      'Łagodne curry z kurczakiem i ryżem, idealne na codzienny obiad. Sos jest kremowy i dobrze łączy przyprawy z mięsem.',
    mealType: L,
    prepTimeMinutes: 32,
    servings: 2,
    nutritionKcal: 1627,
    expected: [L],
  },
];

function fromCatalogue(entry: CatalogueEntry): SuitabilityInput {
  return {
    title: entry.title,
    description: entry.description,
    mealType: entry.mealType,
    prepTimeMinutes: entry.prepTimeMinutes,
    servings: entry.servings,
    nutritionKcal: entry.nutritionKcal,
    suitableMealTypes: [entry.mealType],
  };
}

function recipe(overrides: Partial<SuitabilityInput> = {}): SuitabilityInput {
  return {
    title: 'Kanapka z serem',
    description: null,
    mealType: MealType.BREAKFAST,
    prepTimeMinutes: 10,
    servings: 2,
    nutritionKcal: 600,
    suitableMealTypes: [MealType.BREAKFAST],
    ...overrides,
  };
}

describe('resolveSuitableMealTypes — pełny katalog', () => {
  it.each(CATALOGUE.map((entry) => [entry.title, entry] as const))(
    '%s',
    (_title, entry) => {
      expect(resolveSuitableMealTypes(fromCatalogue(entry))).toEqual(
        entry.expected,
      );
    },
  );

  it('rozkłada sloty tak, jak oczekuje tego raport backfillu', () => {
    const counts = new Map<MealType, number>();
    let changed = 0;

    for (const entry of CATALOGUE) {
      const extra = suggestExtraMealTypes(fromCatalogue(entry));
      if (extra.length > 0) changed += 1;
      for (const suggestion of extra) {
        counts.set(
          suggestion.mealType,
          (counts.get(suggestion.mealType) ?? 0) + 1,
        );
      }
    }

    expect(changed).toBe(8);
    expect(counts.get(SB)).toBe(8);
    expect(counts.get(S)).toBe(3);
    expect(counts.get(AS)).toBe(1);
  });
});

describe('regresje — konkretne błędy, które już raz przeszły do bazy', () => {
  it('danie podane na ciepło nie trafia do slotów przenośnych', () => {
    // 456 kcal/porcja i 14 min mieści się we wszystkich progach — jedyne, co
    // je zatrzymuje, to sposób podania.
    const input = recipe({
      title: 'Kanapki na ciepło z mozzarellą i pomidorem',
      description: 'Szybkie kanapki na ciepło z roztopioną mozzarellą.',
      mealType: MealType.DINNER,
      suitableMealTypes: [MealType.DINNER],
      prepTimeMinutes: 14,
      nutritionKcal: 912,
    });

    expect(suggestExtraMealTypes(input)).toEqual([]);
  });

  it.each([
    'Zapiekane kanapki z serem',
    'Kanapka z serem prosto z patelni',
    'Tortilla podana na gorąco',
    'Kanapka z serem roztopionym w piekarniku',
  ])(
    '„%s” też nie — dyskwalifikuje sposób podania, nie nazwa dania',
    (title) => {
      expect(
        suggestExtraMealTypes(recipe({ title, nutritionKcal: 500 })),
      ).toEqual([]);
    },
  );

  it('wytrawna kanapka z twarożkiem nie jest podwieczorkiem', () => {
    const slots = resolveSuitableMealTypes(
      recipe({
        title: 'Kanapka z twarożkiem i ogórkiem',
        description: 'Świeża kanapka z kremowym twarożkiem i ogórkiem.',
        prepTimeMinutes: 8,
        nutritionKcal: 619,
      }),
    );

    expect(slots).not.toContain(AS);
    expect(slots).toEqual([B, SB, S]);
  });

  it('marker nie łapie w środku wyrazu', () => {
    // „bezowocny" znaczy „daremny" i nie ma nic wspólnego z owocami, ale
    // zawiera w sobie `owoc` — marker słodkiego podwieczorku. Na gołym
    // `includes` wytrawna kanapka jechałaby na podwieczorek przez przymiotnik
    // w opisie. Markery są prefiksami (polski odmienia końcówki), więc
    // dopasowanie musi startować na granicy słowa.
    const slots = resolveSuitableMealTypes(
      recipe({
        title: 'Kanapka z serem',
        description: 'Bezowocna próba ulepszenia klasyki.',
        prepTimeMinutes: 10,
        servings: 1,
        nutritionKcal: 400,
      }),
    );

    expect(slots).not.toContain(AS);
    expect(slots).toEqual([B, SB]);
  });
});

describe('niezmienniki', () => {
  it('nigdy nie zabiera slotów ustawionych ręcznie', () => {
    const input = recipe({
      title: 'Zapiekanka ziemniaczana',
      mealType: MealType.DINNER,
      suitableMealTypes: [MealType.DINNER, MealType.LUNCH],
    });

    expect(resolveSuitableMealTypes(input)).toEqual([L, D]);
  });

  it('zawsze zostawia slot bazowy', () => {
    for (const entry of CATALOGUE) {
      expect(resolveSuitableMealTypes(fromCatalogue(entry))).toContain(
        entry.mealType,
      );
    }
  });

  it('jest idempotentna — drugi przebieg niczego nie dokłada', () => {
    for (const entry of CATALOGUE) {
      const input = fromCatalogue(entry);
      const once = resolveSuitableMealTypes(input);
      const twice = resolveSuitableMealTypes({
        ...input,
        suitableMealTypes: once,
      });

      expect(twice).toEqual(once);
      expect(
        suggestExtraMealTypes({ ...input, suitableMealTypes: once }),
      ).toEqual([]);
    }
  });

  it('podpowiada wyłącznie sloty opcjonalne', () => {
    for (const entry of CATALOGUE) {
      for (const suggestion of suggestExtraMealTypes(fromCatalogue(entry))) {
        expect(OPTIONAL_MEAL_TYPES).toContain(suggestion.mealType);
      }
    }
  });

  it('obiad nigdy nie awansuje do slotu przekąskowego', () => {
    const input = recipe({
      title: 'Sałatka z kurczakiem',
      mealType: MealType.LUNCH,
      suitableMealTypes: [MealType.LUNCH],
      prepTimeMinutes: 5,
      nutritionKcal: 300,
    });

    expect(suggestExtraMealTypes(input)).toEqual([]);
  });

  it('zwraca sloty w kolejności dnia, nie w kolejności reguł', () => {
    const slots = resolveSuitableMealTypes(
      recipe({
        title: 'Jogurt naturalny z musli i jabłkiem',
        prepTimeMinutes: 6,
        nutritionKcal: 677,
      }),
    );

    expect(slots).toEqual([B, SB, AS, S]);
  });
});

describe('dania opisane wprost jako przekąska / deser', () => {
  // Sekcja „Przekąski i desery" w aplikacji zbiera trzy sloty opcjonalne, a
  // import z Thermomixa będzie dowoził dania z bazowym slotem `AFTERNOON_SNACK`
  // albo `SNACK`. Bez awansu między tymi slotami taki deser widać w katalogu,
  // ale da się go zaplanować tylko w jednym slocie — a ten bywa wyłączony.

  it('deser z podwieczorku schodzi też na przekąskę', () => {
    const slots = resolveSuitableMealTypes(
      recipe({
        title: 'Mus czekoladowy z bananem',
        description: 'Kremowy mus na bazie banana, gotowy w kilka minut.',
        mealType: AS,
        suitableMealTypes: [AS],
        prepTimeMinutes: 10,
        nutritionKcal: 600,
      }),
    );

    expect(slots).toEqual([AS, S]);
  });

  it('lekki deser z przekąski wchodzi na podwieczorek i II śniadanie', () => {
    const slots = resolveSuitableMealTypes(
      recipe({
        title: 'Deser jogurtowy z truskawkami',
        description: 'Jogurt z musem truskawkowym.',
        mealType: S,
        suitableMealTypes: [S],
        prepTimeMinutes: 10,
        nutritionKcal: 700,
      }),
    );

    expect(slots).toEqual([SB, AS, S]);
  });

  it('progi obowiązują tak samo — dłuższe wypieki nigdzie nie schodzą', () => {
    const input = recipe({
      title: 'Sernik na zimno z owocami',
      description: 'Sernik bez pieczenia, z galaretką owocową.',
      mealType: AS,
      suitableMealTypes: [AS],
      prepTimeMinutes: 40,
      nutritionKcal: 700,
    });

    expect(suggestExtraMealTypes(input)).toEqual([]);
  });

  it('blokery działają też przy bazie przekąskowej — wytrawne nie jest deserem', () => {
    const slots = resolveSuitableMealTypes(
      recipe({
        title: 'Pasta jajeczna ze szczypiorkiem',
        description: 'Pasta kanapkowa z jajek ze szczypiorkiem.',
        mealType: S,
        suitableMealTypes: [S],
        prepTimeMinutes: 10,
        nutritionKcal: 700,
      }),
    );

    expect(slots).not.toContain(AS);
    expect(slots).toEqual([SB, S]);
  });

  it('jest idempotentna także dla bazy przekąskowej', () => {
    const input = recipe({
      title: 'Koktajl bananowo-truskawkowy z jogurtem',
      mealType: S,
      suitableMealTypes: [S],
      prepTimeMinutes: 5,
      nutritionKcal: 508,
    });
    const once = resolveSuitableMealTypes(input);

    expect(
      resolveSuitableMealTypes({ ...input, suitableMealTypes: once }),
    ).toEqual(once);
  });
});

describe('progi liczą się na porcję', () => {
  it('to samo danie na więcej porcji schodzi niżej w slotach', () => {
    const base = {
      title: 'Jogurt z musli',
      prepTimeMinutes: 5,
      nutritionKcal: 700,
    };

    expect(resolveSuitableMealTypes(recipe({ ...base, servings: 1 }))).toEqual([
      B,
    ]);
    expect(resolveSuitableMealTypes(recipe({ ...base, servings: 2 }))).toEqual([
      B,
      SB,
      AS,
      S,
    ]);
  });

  it('próg jest domknięty od góry — równo na limicie jeszcze przechodzi', () => {
    const atLimit = recipe({
      title: 'Kanapka z serem',
      prepTimeMinutes: 20,
      servings: 1,
      nutritionKcal: 480,
    });
    const overLimit = { ...atLimit, nutritionKcal: 481 };

    expect(resolveSuitableMealTypes(atLimit)).toContain(SB);
    expect(resolveSuitableMealTypes(overLimit)).not.toContain(SB);
  });

  it('servings = 0 nie wysadza dzielenia', () => {
    expect(() =>
      resolveSuitableMealTypes(recipe({ servings: 0 })),
    ).not.toThrow();
  });
});
