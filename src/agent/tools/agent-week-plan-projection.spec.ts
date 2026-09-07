import {
  projectWeekPlanForModel,
  redactViolationsForModel,
} from './agent-tool-executor';

/**
 * Projekcja planu tygodnia dla modelu i redakcja naruszeń.
 *
 * Dwie rzeczy, których nie da się sprawdzić „na oko": ile z modelu domenowego
 * NAPRAWDĘ wychodzi do modelu językowego i czy komunikat bramki bezpieczeństwa
 * na pewno stracił kod alergenu. Obie kosztowały już awarię — pierwsza
 * 33 tys. tokenów na tydzień, druga wyciek alergii domownika bez zgody.
 */

const CONSENTED = '11111111-1111-4111-8111-111111111111';
const WITHHELD = '22222222-2222-4222-8222-222222222222';

type ProjectionInput = Parameters<typeof projectWeekPlanForModel>[0];

function item(overrides: Partial<ProjectionInput['items'][number]> = {}) {
  return {
    dayOfWeek: 'MON',
    mealType: 'DINNER',
    recipeId: 'recipe-1',
    plannedServings: 2,
    participantIds: [] as string[],
    eatenByUserIds: [] as string[],
    recipe: {
      title: 'Leczo z kiełbasą, cukinią i papryką',
      servings: 4,
      prepTimeMinutes: 40,
      nutritionKcal: 2576,
    },
    ...overrides,
  };
}

const refs = new Map([['recipe-1', 'R07']]);
const visible = new Set([CONSENTED]);

describe('projectWeekPlanForModel', () => {
  it('oddaje tylko to, czego model używa do rozumowania', () => {
    const result = projectWeekPlanForModel(
      { weekStart: '2026-10-05', items: [item()] },
      refs,
      visible,
    );

    expect(result).toEqual({
      weekStart: '2026-10-05',
      items: [
        {
          dayOfWeek: 'MON',
          mealType: 'DINNER',
          recipe: 'R07',
          title: 'Leczo z kiełbasą, cukinią i papryką',
          // 2576 kcal to CAŁY przepis na cztery porcje — model myśli porcjami.
          kcalPerServing: 644,
          prepTimeMinutes: 40,
          plannedServings: 2,
        },
      ],
    });
  });

  it('nie ma w wyniku ANI JEDNEGO pola technicznego i żadnego składnika', () => {
    // Nie lista pól „które pamiętamy, żeby usunąć", tylko odwrotnie: wynik ma
    // dokładnie te klucze, co wyżej. Nowe pole w `PLAN_ITEM_INCLUDE` (iOS
    // dokłada je regularnie) nie ma jak przeciec tędy niezauważone.
    const serialized = JSON.stringify(
      projectWeekPlanForModel(
        { weekStart: '2026-10-05', items: [item()] },
        refs,
        visible,
      ),
    );
    for (const zabronione of [
      'ingredients',
      'imageUrl',
      'authorId',
      'householdId',
      'createdAt',
      'updatedAt',
      'weeklyPlanId',
      'description',
      'difficulty',
      'isActive',
      'nutritionProtein',
      'allergens',
      'dietTags',
      'suitableMealTypes',
    ]) {
      expect(serialized).not.toContain(zabronione);
    }
  });

  it('przepis SPOZA katalogu zostaje przy własnym identyfikatorze', () => {
    // Inaczej własny przepis gospodarstwa byłby dla modelu nieosiągalny:
    // digest go nie zawiera, więc `get_week_plan` jest JEDYNĄ drogą do jego
    // identyfikatora — a `resolveRecipeRef` przepuszcza go bez zmian.
    const result = projectWeekPlanForModel(
      {
        weekStart: '2026-10-05',
        items: [item({ recipeId: 'wlasny-przepis-uuid' })],
      },
      refs,
      visible,
    );
    expect(result.items[0].recipe).toBe('wlasny-przepis-uuid');
  });

  describe('prywatność uczestników', () => {
    it('identyfikator osoby ZE zgodą przechodzi — model musi móc go użyć', () => {
      const result = projectWeekPlanForModel(
        {
          weekStart: '2026-10-05',
          items: [item({ participantIds: [CONSENTED] })],
        },
        refs,
        visible,
      );
      expect(result.items[0].participants).toEqual([CONSENTED]);
      expect(result.items[0].othersCount).toBeUndefined();
    });

    it('osoba BEZ zgody zwija się do liczby — bez identyfikatora i bez aliasu', () => {
      const result = projectWeekPlanForModel(
        {
          weekStart: '2026-10-05',
          items: [item({ participantIds: [CONSENTED, WITHHELD] })],
        },
        refs,
        visible,
      );
      expect(result.items[0].participants).toEqual([CONSENTED]);
      expect(result.items[0].othersCount).toBe(1);
      expect(JSON.stringify(result)).not.toContain(WITHHELD);
    });

    it('posiłek wyłącznie dla osób bez zgody niesie samą liczność', () => {
      const result = projectWeekPlanForModel(
        {
          weekStart: '2026-10-05',
          items: [item({ participantIds: [WITHHELD] })],
        },
        refs,
        visible,
      );
      expect(result.items[0].participants).toBeUndefined();
      expect(result.items[0].othersCount).toBe(1);
    });

    it('„zjedzone" to LICZBA, nie lista UUID-ów', () => {
      const result = projectWeekPlanForModel(
        {
          weekStart: '2026-10-05',
          items: [item({ eatenByUserIds: [CONSENTED, WITHHELD] })],
        },
        refs,
        visible,
      );
      expect(result.items[0].eatenCount).toBe(2);
      expect(JSON.stringify(result)).not.toContain(WITHHELD);
      expect(JSON.stringify(result)).not.toContain(CONSENTED);
    });

    it('posiłek dla całego domu nie niesie pól o uczestnikach', () => {
      // Puste audytorium znaczy „wszyscy" i tak jest opisane w prompcie —
      // pusta tablica w każdej z 21 pozycji to kilkaset tokenów za nic.
      const result = projectWeekPlanForModel(
        { weekStart: '2026-10-05', items: [item()] },
        refs,
        visible,
      );
      expect(result.items[0]).not.toHaveProperty('participants');
      expect(result.items[0]).not.toHaveProperty('othersCount');
      expect(result.items[0]).not.toHaveProperty('eatenCount');
    });
  });

  describe('rozmiar pełnego tygodnia (21 pozycji)', () => {
    const dni = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
    const posilki = ['BREAKFAST', 'LUNCH', 'DINNER'];

    const week = (
      overrides: (day: string, meal: string, index: number) => object,
    ) =>
      dni.flatMap((dayOfWeek) =>
        posilki.map((mealType, index) =>
          item({
            dayOfWeek,
            mealType,
            ...overrides(dayOfWeek, mealType, index),
          }),
        ),
      );

    const sizeOf = (
      items: ProjectionInput['items'],
      refByRecipeId: Map<string, string>,
    ) =>
      JSON.stringify(
        projectWeekPlanForModel(
          { weekStart: '2026-10-05', items },
          refByRecipeId,
          visible,
        ),
      ).length;

    /**
     * LIMITY POCHODZĄ Z POMIARU, nie z dopasowania do zielonego wyniku.
     *
     * Zmierzone 7.09.2026 na tytułach z katalogu dev (średnio ~35 znaków):
     * typowy tydzień dla całego domu 3 473 B, tydzień z audytorium i
     * odhaczeniami 5 300 B, skrajny przypadek samych przepisów gospodarstwa
     * (referencja to UUID, nie `R07`) 5 993 B.
     *
     * Dla porównania PRAWDZIWY tydzień 21 pozycji z katalogu dev, zmierzony
     * na obu ścieżkach naraz: 99 477 B przed projekcją, 3 585 B po niej —
     * 27,7× mniej, 4 737 B → 171 B na pozycję.
     *
     * Sufity trzymają zapas na dłuższe tytuły, ale są o rząd wielkości niżej
     * niż stary kształt — regresja w rodzaju „dołóżmy tu jeszcze składniki"
     * przewróci je natychmiast.
     */
    it('typowy tydzień z katalogu, posiłki dla całego domu — poniżej 4 KB', () => {
      const items = week((day, _meal, index) => ({
        recipeId: `recipe-${day}-${index}`,
      }));
      const refs21 = new Map(
        items.map((entry) => [entry.recipeId, 'R07'] as const),
      );
      expect(items).toHaveLength(21);
      expect(sizeOf(items, refs21)).toBeLessThan(4096);
    });

    it('najgorszy przypadek (własne przepisy, audytorium, odhaczenia) — poniżej 8 KB', () => {
      const items = week((day, _meal, index) => ({
        // Bez wpisu w indeksie katalogu referencją jest UUID — 33 znaki
        // drożej na pozycję. Tak wygląda dom, który gotuje z własnych przepisów.
        recipeId: `4b1f0c${index}-0000-4000-8000-00000000${day.toLowerCase()}0`,
        participantIds: [CONSENTED, WITHHELD],
        eatenByUserIds: [CONSENTED, WITHHELD],
      }));
      expect(items).toHaveLength(21);
      expect(sizeOf(items, new Map())).toBeLessThan(8192);
    });
  });
});

describe('redactViolationsForModel', () => {
  it('zabiera kody alergenów, zostawia kod naruszenia', () => {
    const result = redactViolationsForModel({
      weekStart: '2026-10-05',
      checkedSlots: 3,
      violations: [
        {
          dayOfWeek: 'WED',
          mealType: 'DINNER',
          code: 'RECIPE_ALLERGEN_CONFLICT',
          message: 'Danie zawiera alergeny domownika: LACTOSE, GLUTEN.',
        },
      ],
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('LACTOSE');
    expect(serialized).not.toContain('GLUTEN');
    // Kod ZOSTAJE: bez niego model wie tylko tyle, że „coś jest nie tak".
    expect(serialized).toContain('RECIPE_ALLERGEN_CONFLICT');
  });

  it('działa tak samo dla wykluczonych składników', () => {
    const result = redactViolationsForModel({
      violations: [
        {
          code: 'RECIPE_EXCLUDED_INGREDIENT',
          message: 'Danie zawiera składnik: pieczarki.',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('pieczarki');
    expect(JSON.stringify(result)).toContain('RECIPE_EXCLUDED_INGREDIENT');
  });

  it('naruszenia bez danych osobowych zostają NIETKNIĘTE', () => {
    // Redakcja ma zabierać dane o zdrowiu, a nie kaleczyć komunikaty, po
    // których model poprawia plan („ten przepis nie nadaje się do tego posiłku").
    const violations = [
      {
        code: 'RECIPE_NOT_SUITABLE_FOR_SLOT',
        message: 'Ten przepis nie nadaje się do tego posiłku.',
      },
      { code: 'RECIPE_NOT_FOUND', message: 'Nie znaleziono przepisu.' },
    ];
    expect(redactViolationsForModel({ violations }).violations).toEqual(
      violations,
    );
  });

  it('wynik bez naruszeń przechodzi bez zmian — ta sama referencja', () => {
    const plain = { weekStart: '2026-10-05', items: [] };
    expect(redactViolationsForModel(plain)).toBe(plain);
  });

  /**
   * SEDNO POPRAWKI Z 7.09.2026. Wyciek wziął się stąd, że redakcja
   * rozpoznawała naruszenia po NAZWIE POLA (`violations`), a
   * `check_plan_conflicts` nazywał je `conflicts`. Ujednolicenie nazwy
   * naprawiło jeden przypadek i zostawiło klasę błędu. Teraz liczy się
   * kształt, więc te testy pilnują, że nazwa pola nie ma już nic do rzeczy.
   */
  describe('nazwa pola nie ma znaczenia — liczy się kształt', () => {
    const naruszenie = {
      dayOfWeek: 'WED',
      mealType: 'DINNER',
      code: 'RECIPE_ALLERGEN_CONFLICT',
      message: 'Danie zawiera alergeny domownika: LACTOSE, GLUTEN.',
    };

    it.each(['violations', 'conflicts', 'problems', 'issues', 'errors'])(
      'redaguje naruszenia w polu %s',
      (pole) => {
        const wynik = JSON.stringify(
          redactViolationsForModel({ [pole]: [naruszenie] }),
        );
        expect(wynik).not.toContain('LACTOSE');
        expect(wynik).not.toContain('GLUTEN');
        expect(wynik).toContain('RECIPE_ALLERGEN_CONFLICT');
      },
    );

    it('redaguje naruszenie ZAGNIEŻDŻONE, nie tylko na wierzchu', () => {
      // Tak wygląda wynik narzędzia opakowany w kopertę albo w kartę:
      // gdyby redakcja patrzyła tylko na pierwszy poziom, przeszłoby.
      const wynik = JSON.stringify(
        redactViolationsForModel({
          ok: true,
          data: { preview: { slots: [{ ...naruszenie }] } },
        }),
      );
      expect(wynik).not.toContain('LACTOSE');
      expect(wynik).toContain('RECIPE_ALLERGEN_CONFLICT');
    });

    it('redaguje naruszenie stojące SAMO, bez tablicy wokół', () => {
      const wynik = redactViolationsForModel({ violation: naruszenie }) as {
        violation: { message: string };
      };
      expect(wynik.violation.message).not.toMatch(/lactose|gluten/i);
      expect(wynik.violation.message).toContain('wybierz inne danie');
    });

    it('nie rusza obiektu z kodem, ale bez komunikatu', () => {
      const bezKomunikatu = { code: 'RECIPE_ALLERGEN_CONFLICT' };
      const wejscie = { violations: [bezKomunikatu] };
      expect(redactViolationsForModel(wejscie)).toBe(wejscie);
    });

    it('nie rusza kodów spoza tabeli — redakcja to nie cenzura', () => {
      // `RECIPE_NOT_FOUND` i spółka mówią modelowi, co poprawić, i nie niosą
      // ani jednej danej o zdrowiu. Zabranie im treści byłoby stratą.
      const inne = {
        violations: [
          { code: 'RECIPE_NOT_SUITABLE_FOR_SLOT', message: 'Nie ten posiłek.' },
        ],
      };
      expect(redactViolationsForModel(inne)).toBe(inne);
    });

    it('nie wywraca się na strukturze głębszej niż sufit redakcji', () => {
      let glebokie: Record<string, unknown> = { ...naruszenie };
      for (let i = 0; i < 40; i += 1) glebokie = { poziom: glebokie };
      expect(() => redactViolationsForModel(glebokie)).not.toThrow();
    });
  });
});
