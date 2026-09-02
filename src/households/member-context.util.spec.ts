import {
  MemberContextRow,
  PREFERENCE_DEFAULTS,
  toMemberContext,
} from './member-context.util';

const NOW = new Date('2026-08-31T00:00:00.000Z');

const row = (overrides: {
  user?: Partial<MemberContextRow['user']>;
  preferences?: Partial<
    NonNullable<MemberContextRow['user']['preferences']>
  > | null;
  role?: MemberContextRow['role'];
}): MemberContextRow => ({
  role: overrides.role ?? 'OWNER',
  user: {
    id: 'u1',
    displayName: 'Rafał',
    sex: 'MALE',
    heightCm: 180,
    weightKg: 80,
    yearOfBirth: 1996,
    preferences:
      overrides.preferences === null
        ? null
        : {
            dietPreference: 'NONE',
            calorieGoal: 2350,
            allergens: [],
            goal: 'LOSE',
            activityLevel: 3,
            proteinG: null,
            fatG: null,
            carbsG: null,
            ...overrides.preferences,
          },
    ...overrides.user,
  },
});

describe('toMemberContext', () => {
  it('liczy makra z sylwetki i celu, gdy nikt ich nie nadpisał', () => {
    const context = toMemberContext(row({}), NOW);
    // Te same liczby, co w `body-metrics.util.spec.ts` (parytet z iOS).
    expect(context.targets).toEqual({
      calorieGoal: 2350,
      macros: { proteinG: 170, fatG: 65, carbsG: 275 },
      macrosSource: 'COMPUTED',
    });
  });

  it('ręczne nadpisanie wygrywa z rachunkiem', () => {
    const context = toMemberContext(
      row({ preferences: { proteinG: 200, fatG: 70, carbsG: 220 } }),
      NOW,
    );
    expect(context.targets.macros).toEqual({
      proteinG: 200,
      fatG: 70,
      carbsG: 220,
    });
    expect(context.targets.macrosSource).toBe('STORED');
  });

  it('częściowe nadpisanie NIE miesza się z policzonym', () => {
    // Zestaw „ręczne białko + policzona reszta" nie sumowałby się do celu
    // kalorycznego, a użytkownik zobaczyłby liczby, których nie ustawiał.
    const context = toMemberContext(
      row({ preferences: { proteinG: 200 } }),
      NOW,
    );
    expect(context.targets.macrosSource).toBe('COMPUTED');
    expect(context.targets.macros?.proteinG).toBe(170);
  });

  it('bez sylwetki oddaje sam cel kaloryczny, nie zgadnięte gramy', () => {
    const context = toMemberContext(
      row({ user: { weightKg: null, heightCm: null } }),
      NOW,
    );
    expect(context.targets.macros).toBeNull();
    expect(context.targets.macrosSource).toBe('UNAVAILABLE');
    expect(context.targets.calorieGoal).toBe(2350);
  });

  it('konto bez wiersza preferencji czyta domyślne ze schematu', () => {
    // Normalny stan konta, które nie przeszło kreatora — nie wywrotka.
    const context = toMemberContext(row({ preferences: null }), NOW);
    expect(context.dietPreference).toBe(PREFERENCE_DEFAULTS.dietPreference);
    expect(context.goal).toBe(PREFERENCE_DEFAULTS.goal);
    expect(context.activityLevel).toBe(PREFERENCE_DEFAULTS.activityLevel);
    expect(context.targets.calorieGoal).toBe(PREFERENCE_DEFAULTS.calorieGoal);
    expect(context.allergens).toEqual([]);
  });

  it('niesie to, po co asystent w ogóle pyta: dietę, alergeny i rolę', () => {
    const context = toMemberContext(
      row({
        role: 'MEMBER',
        preferences: {
          dietPreference: 'VEGETARIAN',
          allergens: ['nuts', 'lactose'],
        },
      }),
      NOW,
    );
    expect(context).toMatchObject({
      userId: 'u1',
      displayName: 'Rafał',
      role: 'MEMBER',
      dietPreference: 'VEGETARIAN',
      allergens: ['nuts', 'lactose'],
    });
  });

  it('sylwetka jest tylko wejściem do rachunku — na zewnątrz nie wychodzi', () => {
    // Ten obiekt trafia do promptu (Anthropic, USA), do narzędzia asystenta
    // i na telefon każdego domownika. Waga i wzrost drugiej osoby nie mają
    // prawa tam być — cele są już policzone w `targets`.
    const context = toMemberContext(row({}), NOW);
    expect(context.targets.macrosSource).toBe('COMPUTED');
    expect(context).not.toHaveProperty('body');
    const serialized = JSON.stringify(context);
    for (const field of ['sex', 'heightCm', 'weightKg', 'yearOfBirth']) {
      expect(serialized).not.toContain(`"${field}"`);
    }
    expect(serialized).not.toContain('MALE');
    expect(serialized).not.toContain('1996');
  });
});
