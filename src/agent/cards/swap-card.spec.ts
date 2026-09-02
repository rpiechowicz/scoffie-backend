import { buildSwapCard } from './swap-card';
import { buildOptionsCard, optionPrompt } from './options-card';

// Karta podmiany odpowiada na jedno pytanie: co się zmieni. Te testy pilnują,
// żeby nie odpowiadała na nie szumem („0 min”) ani nie chwaliła się zmianą,
// której nie ma.

const side = (over: Record<string, unknown> = {}) => ({
  recipeId: 'r-1',
  title: 'Gulasz wołowy z kaszą',
  kcalPerServing: 720,
  prepTimeMinutes: 55,
  ...over,
});

const build = (over: Record<string, unknown> = {}) =>
  buildSwapCard({
    proposalId: 'p-1',
    weekStart: '2026-08-31',
    date: '2026-09-01',
    dayOfWeek: 'TUE',
    mealType: 'DINNER',
    from: side(),
    to: side({
      recipeId: 'r-2',
      title: 'Omlet ze szpinakiem',
      kcalPerServing: 393,
      prepTimeMinutes: 12,
    }),
    expiresAt: new Date('2026-09-03T10:00:00.000Z'),
    ...over,
  } as never);

describe('buildSwapCard', () => {
  it('pokazuje obie strony i nazywa największą różnicę', () => {
    const card = build();
    expect(card.eyebrow).toBe('Podmiana · wtorek, kolacja');
    expect(card.title).toBe('Szybciej o 43 min');
    expect(card.from?.title).toBe('Gulasz wołowy z kaszą');
    expect(card.to.title).toBe('Omlet ze szpinakiem');
    expect(card.deltas).toEqual([
      { value: '−43 min', label: 'szybciej', good: true },
      { value: '−327 kcal', label: 'na porcję', good: true },
    ]);
  });

  it('drobne różnice przemilcza — „0 min” każe szukać zmiany tam, gdzie jej nie ma', () => {
    const card = build({
      to: side({
        recipeId: 'r-3',
        title: 'Gulasz z indyka',
        kcalPerServing: 700,
        prepTimeMinutes: 52,
      }),
      reason: 'Chciałeś coś lżejszego',
    });
    expect(card.deltas).toEqual([]);
    expect(card.title).toBe('Chciałeś coś lżejszego');
  });

  it('podmiana na cięższe danie nie udaje, że to zysk', () => {
    const card = build({
      from: side({ kcalPerServing: 300, prepTimeMinutes: 10 }),
      to: side({
        recipeId: 'r-4',
        title: 'Schab pieczony',
        kcalPerServing: 820,
        prepTimeMinutes: 90,
      }),
    });
    expect(card.title).toBe('Dłużej o 80 min');
    expect(card.deltas.every((delta) => !delta.good)).toBe(true);
  });

  it('pusty slot to nie podmiana, tylko dołożenie', () => {
    const card = build({ from: null });
    expect(card.title).toBe('Wolne miejsce w planie');
    expect(card.deltas).toEqual([]);
    expect(card.actions[0].label).toBe('Dodaj do planu');
  });

  it('propozycja czeka na kliknięcie, nie zapisuje się sama', () => {
    expect(build().state).toMatchObject({ status: 'PENDING', canApply: true });
  });
});

describe('buildOptionsCard', () => {
  const option = (title: string, over: Record<string, unknown> = {}) => ({
    recipeId: `r-${title}`,
    title,
    kcalPerServing: 500,
    prepTimeMinutes: 20,
    imageUrl: null,
    tag: null,
    prompt: optionPrompt(title),
    ...over,
  });

  it('dotknięcie kafelka wysyła wybór jako zwykłą wiadomość', () => {
    const card = buildOptionsCard({
      title: 'Trzy szybkie kolacje',
      slotLabel: 'Kolacja · wtorek',
      options: [option('Omlet'), option('Sałatka')],
    });

    expect(card.kind).toBe('OPTIONS');
    expect(card.eyebrow).toBe('Kolacja · wtorek');
    expect(card.options[0].prompt).toBe('Wybieram: Omlet');
    // Karta wyboru nie ma stanu ani propozycji — nie ma czego zatwierdzać.
    expect(card).not.toHaveProperty('state');
    expect(card).not.toHaveProperty('proposalId');
  });

  it('zawsze zostawia wyjście „żadne z tych”', () => {
    const card = buildOptionsCard({
      title: 'Do wyboru',
      options: [option('A'), option('B')],
    });
    expect(card.actions).toEqual([
      {
        type: 'ASK',
        proposalId: null,
        label: 'Coś innego',
        style: 'SECONDARY',
        prompt: 'Żadne z tych mi nie pasuje. Zaproponuj coś innego.',
      },
    ]);
  });

  it('przycina do czterech — dalej to już lista, nie wybór', () => {
    const card = buildOptionsCard({
      title: 'Dużo',
      options: [
        option('A'),
        option('B'),
        option('C'),
        option('D'),
        option('E'),
      ],
    });
    expect(card.options).toHaveLength(4);
  });

  it('brak etykiety slotu nie zostawia pustego nadtytułu', () => {
    const card = buildOptionsCard({ title: 'X', options: [option('A')] });
    expect(card.eyebrow).toBe('Do wyboru');
  });
});
