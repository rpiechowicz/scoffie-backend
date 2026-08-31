import {
  basalMetabolicRate,
  buildBodyMetrics,
  macroTargets,
  proteinPerKilogram,
  snapCalories,
  snapGrams,
  suggestedCalories,
  totalDailyEnergyExpenditure,
  type BodyMetrics,
} from './body-metrics.util';

/**
 * Parytet z iOS (`weekly meals/Models/Components/BodyMetrics.swift`).
 *
 * Liczby poniżej są policzone RĘCZNIE ze wzorów w Swifcie, nie wygenerowane
 * z tej implementacji — inaczej test potwierdzałby tylko sam siebie. Gdy
 * którakolwiek strona zmieni wzór, ten plik ma zapalić się na czerwono:
 * użytkownik widzi swój cel w Ustawieniach (iOS) i dostaje pod niego plan
 * od asystenta (serwer), więc rozjazd byłby widoczny wprost.
 */
const metrics = (overrides: Partial<BodyMetrics> = {}): BodyMetrics => ({
  heightCm: 180,
  weightKg: 80,
  age: 30,
  activity: 3,
  sex: 'MALE',
  ...overrides,
});

describe('basalMetabolicRate (Mifflin-St Jeor)', () => {
  it('mężczyzna 180 cm / 80 kg / 30 lat → 1780', () => {
    // 10·80 + 6,25·180 − 5·30 + 5
    expect(basalMetabolicRate(metrics())).toBe(1780);
  });

  it('kobieta 165 cm / 60 kg / 40 lat → 1270,25', () => {
    // 10·60 + 6,25·165 − 5·40 − 161
    expect(
      basalMetabolicRate(
        metrics({ heightCm: 165, weightKg: 60, age: 40, sex: 'FEMALE' }),
      ),
    ).toBeCloseTo(1270.25, 5);
  });

  it('bez płci bierze środek obu wariantów (−78), nie zero', () => {
    // Konta sprzed dodania pola: rozjazd ±83 kcal zamiast wywrotki.
    expect(basalMetabolicRate(metrics({ sex: null }))).toBe(1697);
  });
});

describe('totalDailyEnergyExpenditure', () => {
  it.each([
    [1, 1.2],
    [2, 1.375],
    [3, 1.55],
    [4, 1.725],
  ])('aktywność %i → BMR × %f', (activity, multiplier) => {
    expect(
      totalDailyEnergyExpenditure(metrics({ activity: activity as 1 })),
    ).toBeCloseTo(1780 * multiplier, 5);
  });
});

describe('suggestedCalories', () => {
  it('MAINTAIN = TDEE zaokrąglone do 50', () => {
    // 1780 × 1,55 = 2759 → 2750
    expect(suggestedCalories('MAINTAIN', metrics())).toBe(2750);
  });

  it('LOSE to 15% deficytu, nie ryczałt', () => {
    // max(2759 × 0,85 = 2345,15 ; BMR 1780) → 2350
    expect(suggestedCalories('LOSE', metrics())).toBe(2350);
  });

  it('LOSE nigdy nie schodzi poniżej BMR', () => {
    // Osoba mało aktywna: TDEE 1780×1,2 = 2136; 85% = 1815,6 < BMR 1780? nie.
    // Dla pewności bierzemy skrajność: bardzo lekka i siedząca sylwetka.
    const light = metrics({
      weightKg: 45,
      heightCm: 150,
      age: 60,
      activity: 1,
    });
    const bmr = basalMetabolicRate(light);
    expect(suggestedCalories('LOSE', light)).toBeGreaterThanOrEqual(
      snapCalories(bmr),
    );
  });

  it('GAIN to 12% nadwyżki', () => {
    // 2759 × 1,12 = 3090,08 → 3100
    expect(suggestedCalories('GAIN', metrics())).toBe(3100);
  });

  it('bez sylwetki spada do płaskiej podpowiedzi z celu', () => {
    expect(suggestedCalories('LOSE', null)).toBe(1800);
    expect(suggestedCalories('GAIN', null)).toBe(2700);
    expect(suggestedCalories('HEALTHY', null)).toBe(2200);
    expect(suggestedCalories('MAINTAIN', null)).toBe(2200);
    expect(suggestedCalories('PLAN', null)).toBe(2300);
  });
});

describe('proteinPerKilogram', () => {
  it('cel daje bazę, treningi ją przesuwają', () => {
    expect(proteinPerKilogram('LOSE', 3)).toBeCloseTo(2.1, 5); // 1,9 + 0,2
    expect(proteinPerKilogram('MAINTAIN', 2)).toBeCloseTo(1.5, 5);
    expect(proteinPerKilogram('PLAN', 1)).toBeCloseTo(1.0, 5); // 1,2 − 0,2
  });

  it('trzyma się zakresu 1,0–2,4 g/kg', () => {
    expect(proteinPerKilogram('LOSE', 4)).toBeCloseTo(2.25, 5);
    expect(proteinPerKilogram('PLAN', 1)).toBeGreaterThanOrEqual(1.0);
    expect(proteinPerKilogram('LOSE', 4)).toBeLessThanOrEqual(2.4);
  });
});

describe('macroTargets', () => {
  it('mężczyzna 80 kg, LOSE, 2350 kcal → 170 / 65 / 275', () => {
    // białko round(80 × 2,1) = 168 → 170; tłuszcz max(2350×0,25/9 = 65,3 ; 48)
    // = 65; węgle round((2350 − 672 − 585)/4) = 273 → 275
    expect(macroTargets('LOSE', 2350, metrics())).toEqual({
      proteinG: 170,
      fatG: 65,
      carbsG: 275,
    });
  });

  it('kobieta 60 kg, MAINTAIN, 1500 kcal → 80 / 50 / 185', () => {
    expect(
      macroTargets(
        'MAINTAIN',
        1500,
        metrics({
          heightCm: 165,
          weightKg: 60,
          age: 40,
          sex: 'FEMALE',
          activity: 1,
        }),
      ),
    ).toEqual({ proteinG: 80, fatG: 50, carbsG: 185 });
  });

  it('podłoga tłuszczu 0,6 g/kg wygrywa z udziałem w kaloriach', () => {
    // 100 kg przy 1200 kcal: 1200×0,25/9 = 33,3 g, podłoga = 60 g.
    const heavy = metrics({ weightKg: 100 });
    expect(macroTargets('LOSE', 1200, heavy)?.fatG).toBe(60);
  });

  it('węglowodany nie schodzą poniżej zera przy skrajnie niskim celu', () => {
    const targets = macroTargets('LOSE', 0, metrics());
    expect(targets?.carbsG).toBe(0);
  });

  it('bez sylwetki nie ma czego liczyć — makra zależą od masy ciała', () => {
    expect(macroTargets('LOSE', 2350, null)).toBeNull();
  });

  it('więcej treningów przy tym samym celu = więcej węglowodanów', () => {
    // To jest sens wciągnięcia aktywności do makr, nie tylko do kalorii.
    const spokojnie = macroTargets('MAINTAIN', 2500, metrics({ activity: 1 }));
    const trening = macroTargets('MAINTAIN', 2500, metrics({ activity: 4 }));
    expect(trening!.proteinG).toBeGreaterThan(spokojnie!.proteinG);
  });
});

describe('zaokrąglenia', () => {
  it('kalorie chodzą po 50 i mieszczą się w zakresie suwaka', () => {
    expect(snapCalories(2345.15)).toBe(2350);
    expect(snapCalories(2324)).toBe(2300);
    expect(snapCalories(100)).toBe(1200);
    expect(snapCalories(99_999)).toBe(3500);
  });

  it('gramy chodzą po 5 i nie schodzą poniżej zera', () => {
    expect(snapGrams(168)).toBe(170);
    expect(snapGrams(167)).toBe(165);
    expect(snapGrams(-10)).toBe(0);
  });
});

describe('buildBodyMetrics', () => {
  const now = new Date('2026-08-31T00:00:00.000Z');
  const input = {
    heightCm: 180,
    weightKg: 80,
    yearOfBirth: 1996,
    activityLevel: 3,
    sex: 'MALE' as const,
  };

  it('liczy wiek z roku urodzenia', () => {
    expect(buildBodyMetrics(input, now)?.age).toBe(30);
  });

  it.each([
    ['brak wzrostu', { heightCm: null }],
    ['brak wagi', { weightKg: null }],
    ['brak rocznika', { yearOfBirth: null }],
    ['wzrost poza zakresem', { heightCm: 100 }],
    ['waga poza zakresem', { weightKg: 300 }],
    ['wiek poniżej 13', { yearOfBirth: 2020 }],
    ['nieznany poziom aktywności', { activityLevel: 7 }],
  ])('oddaje null: %s', (_label, patch) => {
    // Bez tego UI (i asystent) liczyłyby zapotrzebowanie z zer.
    expect(buildBodyMetrics({ ...input, ...patch }, now)).toBeNull();
  });

  it('brak płci NIE blokuje rachunku — obniża tylko dokładność', () => {
    const result = buildBodyMetrics({ ...input, sex: null }, now);
    expect(result).not.toBeNull();
    expect(result?.sex).toBeNull();
  });
});
