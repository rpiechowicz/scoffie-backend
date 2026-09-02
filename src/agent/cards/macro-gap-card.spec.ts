import { buildMacroGapCard } from './macro-gap-card';
import { buildHouseholdSplitCard, goalLabel } from './household-split-card';

// Obie karty mówią o rzeczach, których użytkownik sam nie policzy: ile mu
// brakuje i jak podać jedno danie czterem osobom. Wiarygodność obu stoi na
// tym, że liczby i cele NIE pochodzą od modelu.

describe('buildMacroGapCard', () => {
  const booster = (text: string, amount: number) => ({ text, amount });

  it('brak stoi w tytule, bo to jest cała treść karty', () => {
    const card = buildMacroGapCard({
      macro: 'PROTEIN',
      current: 96,
      target: 140,
      scopeLabel: 'ten tydzień',
      boosters: [booster('Twarożek zamiast musli (śr.)', 24)],
    });

    expect(card.eyebrow).toBe('Białko · ten tydzień');
    expect(card.title).toBe('Brakuje średnio 44 g dziennie');
    expect(card.unit).toBe('g');
  });

  it('dowieziony cel nie udaje problemu', () => {
    const card = buildMacroGapCard({
      macro: 'PROTEIN',
      current: 150,
      target: 140,
      scopeLabel: 'ten tydzień',
      boosters: [],
    });
    expect(card.title).toBe('Cel dowieziony, z zapasem 10 g');
    // Bez zmian do zastosowania nie ma czego proponować.
    expect(card.actions).toEqual([]);
  });

  it('kalorie mają swoją jednostkę', () => {
    const card = buildMacroGapCard({
      macro: 'KCAL',
      current: 1700,
      target: 2100,
      scopeLabel: 'ten tydzień',
      boosters: [booster('Większa porcja obiadu', 300)],
    });
    expect(card.unit).toBe('kcal');
    expect(card.title).toBe('Brakuje średnio 400 kcal dziennie');
  });

  it('przycisk zastosowania NIE zapisuje — wysyła wiadomość', () => {
    const card = buildMacroGapCard({
      macro: 'PROTEIN',
      current: 96,
      target: 140,
      scopeLabel: 'ten tydzień',
      boosters: [
        booster('A', 10),
        booster('B', 20),
        booster('C', 30),
        booster('D', 40),
      ],
    });
    expect(card.boosters).toHaveLength(3);
    expect(card.actions[0]).toMatchObject({
      type: 'ASK',
      label: 'Zastosuj wszystkie trzy',
      proposalId: null,
    });
    // Karta bez propozycji nie ma stanu do kliknięcia.
    expect(card).not.toHaveProperty('state');
  });
});

describe('buildHouseholdSplitCard', () => {
  const portion = (name: string, over: Record<string, unknown> = {}) => ({
    userId: `u-${name}`,
    displayName: name,
    goalLabel: '2100 kcal',
    note: 'Duża porcja',
    kcal: 740,
    ...over,
  });

  it('nadtytuł liczy talerze, a przycisk nazywa dzień', () => {
    const card = buildHouseholdSplitCard({
      proposalId: 'p-1',
      weekStart: '2026-08-31',
      date: '2026-09-02',
      dayOfWeek: 'WED',
      mealType: 'DINNER',
      title: 'Gulasz wołowy z kaszą',
      prepTimeMinutes: 55,
      portions: [
        portion('Ty'),
        portion('Ania'),
        portion('Zosia'),
        portion('Franek'),
      ],
      expiresAt: new Date('2026-09-03T10:00:00.000Z'),
    });

    expect(card.eyebrow).toBe('Jedna baza · cztery porcje');
    expect(card.title).toBe('Gulasz wołowy z kaszą');
    // „na środę”, nie „na środa” — przycisk mówi zdaniem.
    expect(card.actions[0].label).toBe('Zapisz na środę');
    expect(card.portions).toHaveLength(4);
    expect(card.state).toMatchObject({ status: 'PENDING', canApply: true });
  });
});

describe('goalLabel', () => {
  it('składa cel, dietę i alergeny w jedną linię', () => {
    expect(
      goalLabel({
        calorieGoal: 1400,
        dietPreference: 'VEGETARIAN',
        allergens: ['lactose'],
      }),
    ).toBe('1400 kcal · wegetariańska · bez laktozy');
  });

  it('sam cel, gdy nic go nie zawęża', () => {
    expect(
      goalLabel({ calorieGoal: 2100, dietPreference: 'NONE', allergens: [] }),
    ).toBe('2100 kcal');
  });

  it('długą listę alergenów przycina — ogon jest mniej ważny niż imię obok', () => {
    const label = goalLabel({
      calorieGoal: 2000,
      dietPreference: 'NONE',
      allergens: ['gluten', 'lactose', 'eggs', 'nuts', 'soy'],
    });
    expect(label).toBe('2000 kcal · bez glutenu, laktozy, jajek');
  });
  it('każdy booster ma własne pytanie (strzałka wysyła wiadomość, nic nie zapisuje)', () => {
    const card = buildMacroGapCard({
      macro: 'FAT',
      current: 88,
      target: 70,
      scopeLabel: 'ten tydzień',
      boosters: [
        { text: 'Twaróg zamiast fety (pon., sob.)', amount: -11 },
        { text: 'Jogurt zamiast śmietany (śr.)', amount: -6, prompt: 'Własne' },
      ],
    });
    expect(card.boosters.map((b) => b.prompt)).toEqual([
      'Zastosuj w planie tę zmianę: Twaróg zamiast fety (pon., sob.). Pokaż mi ją jako propozycję.',
      'Własne',
    ]);
  });
});
