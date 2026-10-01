import { normalizeText } from '../../../common/normalize-text.util';
import {
  ingredientNamed,
  qualityChecks,
  recipeDurationPool,
  recipeDurations,
  resolveWriterOutput,
  shownLength,
  skipGuard,
  splitRecipeVariants,
  timelineFloorSeconds,
} from './writer.checks';
import {
  clone,
  kotletExample,
  type Content,
} from './writer.fixtures.spec-helper';
import { buildWriterSystem, exampleOutput } from './writer.prompt';
import type { WriterRecipe } from './writer.types';

const example = kotletExample();
const kotlet = example.recipe;
const output = () =>
  clone(exampleOutput(kotlet, example.content)) as {
    scenario: {
      steps: Array<
        Record<string, unknown> & {
          body: string;
          ingredients: Array<{ key: string }>;
        }
      >;
    };
  };

describe('system pisania — walidatory twarde', () => {
  it('wzorzec kotleta: odpowiedź modelu z kluczami wraca do tej samej treści i przechodzi wszystko', () => {
    const resolved = resolveWriterOutput(kotlet, output());
    expect(resolved.errors).toEqual([]);
    expect(resolved.content).toEqual(example.content);
    expect(qualityChecks(kotlet, resolved.content!).errors).toEqual([]);
  });

  it('prompt systemowy zawiera zasady i wzorzec z kluczami, nie z id', () => {
    const system = buildWriterSystem(example);
    expect(system).toContain('KIEDY NIE PISAĆ');
    expect(system).toContain('i1 — ');
    expect(system).toContain('"key":"i');
  });

  it('klucz spoza przepisu = błąd z miejscem', () => {
    const bad = output();
    bad.scenario.steps[0].ingredients[0].key = 'i99';
    const resolved = resolveWriterOutput(kotlet, bad);
    expect(resolved.content).toBeNull();
    expect(resolved.errors).toContain(
      's1.ingredients[0]: klucza „i99” nie ma w przepisie',
    );
  });

  it('SKIP bez powodu i zła decyzja to błędy', () => {
    expect(
      resolveWriterOutput(kotlet, {
        decision: 'SKIP',
        skipReason: ' ',
        scenario: null,
      }).errors,
    ).toEqual(['SKIP bez powodu (skipReason)']);
    expect(resolveWriterOutput(kotlet, { decision: 'MAYBE' }).errors).toEqual([
      'decision: WRITE albo SKIP',
    ]);
  });

  describe('liczby w tekście', () => {
    const withBody = (body: string) => {
      const content = clone(example.content);
      content.steps[1].body = body;
      return qualityChecks(kotlet, content).errors;
    };

    it('ilość składnika cyframi = błąd', () => {
      expect(withBody('Dodaj 2 jajka i wymieszaj.')).toEqual([
        expect.stringContaining('s2.body: liczba „2”'),
      ]);
    });

    it('czasy, temperatury, rozmiary, tokeny i nazwy z cyfrą przechodzą', () => {
      expect(
        withBody(
          'Smaż 10–12 min w 180°C, rozbij na 0,5 cm, dodaj śmietana 12 i uformuj {count:rolls|wałeczek|wałeczki|wałeczków}.',
        ),
      ).toEqual([]);
    });

    it('wymiar „3 × 4 cm” przechodzi (test paczek E3b, nuggetsy)', () => {
      expect(
        withBody('Pokrój w kawałki ok. 3 × 4 cm, a blachę 20 x 30 cm wyłóż.'),
      ).toEqual([]);
      expect(withBody('Weź 3 × jajko.')).toEqual([
        expect.stringContaining('s2.body: liczba „3”'),
      ]);
    });

    it('zły token = błąd', () => {
      expect(withBody('Uformuj {ilość} wałeczków.')).toEqual([
        expect.stringContaining('zły token'),
      ]);
    });
  });

  it('startLabel to sam warunek startu — bez czasu i „odliczaj” (zasady .5)', () => {
    const content = clone(example.content);
    const step = content.steps.find((s) => s.timer)!;
    expect(
      qualityChecks(kotlet, content).errors.filter((e) =>
        e.includes('startLabel'),
      ),
    ).toEqual([]);
    step.timer!.startLabel = 'Woda wrze — odliczaj 20 min';
    expect(qualityChecks(kotlet, content).errors).toContainEqual(
      expect.stringContaining(`${step.id}.timer.startLabel`),
    );
    step.timer!.startLabel = 'Po 5 min zamieszaj';
    expect(qualityChecks(kotlet, content).errors).toContainEqual(
      expect.stringContaining(`${step.id}.timer.startLabel`),
    );
    // Liczba w nazwie składnika to nie czas (review Codexa).
    step.timer!.startLabel = 'Śmietana 12% w misce';
    expect(
      qualityChecks(kotlet, content).errors.filter((e) =>
        e.includes('startLabel'),
      ),
    ).toEqual([]);
    // Czas słownie też jest powtórzeniem (review Codexa, runda 2).
    for (const label of [
      'Po pięciu minutach',
      'Za dwie minuty',
      'Po półtorej',
      // Runda 3 Codexa: odmiana „minucie” i skróty bez liczby.
      'Po minucie',
      'Po min.',
      'Po sek.',
    ]) {
      step.timer!.startLabel = label;
      expect(qualityChecks(kotlet, content).errors).toContainEqual(
        expect.stringContaining(`${step.id}.timer.startLabel`),
      );
    }
    step.timer!.startLabel = 'Za kwadrans';
    expect(qualityChecks(kotlet, content).errors).toContainEqual(
      expect.stringContaining(`${step.id}.timer.startLabel`),
    );
  });

  it('limity pisania (.5): tytuł 30, treść 260 (token liczony jak widać), startLabel 20', () => {
    const content = clone(example.content);
    const step = content.steps.find((s) => s.timer)!;
    step.title = 'x'.repeat(31);
    step.body = `${'a'.repeat(240)} {count:cutlets|kotlet|kotlety|kotletów}`;
    step.timer!.startLabel = 'Kotlety na dużej patelni';
    const errors = qualityChecks(kotlet, content).errors;
    expect(errors).toContainEqual(
      expect.stringContaining(
        `${step.id}.title „${'x'.repeat(31)}”: 31 znaków, limit 30`,
      ),
    );
    // 240 liter + spacja + token (liczba + „kotletów” = 12 znaków) = 253 → mieści się.
    expect(errors.filter((e) => e.startsWith(`${step.id}.body:`))).toEqual([]);
    expect(errors).toContainEqual(
      expect.stringContaining(
        `${step.id}.timer.startLabel „Kotlety na dużej patelni”: 24 znaków, limit 20`,
      ),
    );
    step.body = 'a'.repeat(261);
    expect(qualityChecks(kotlet, content).errors).toContainEqual(
      expect.stringContaining(`${step.id}.body: 261 znaków, limit 260`),
    );
  });

  it('„W MIĘDZYCZASIE” w obie strony: krok z during ma dokładnie tę etykietę (review Codexa)', () => {
    for (const stage of [null, 'PRZYGOTOWANIE', 'W MIEDZYCZASIE']) {
      const content = clone(example.content);
      const step = content.steps.find((s) => s.during)!;
      step.stage = stage;
      expect(qualityChecks(kotlet, content).errors).toContainEqual(
        expect.stringContaining(`${step.id}.stage: krok w trakcie timera`),
      );
    }
  });

  it('składnik w tekście: rdzeń od początku słowa — „do smaku” to nie mąka, „serwuj” to nie ser, „posól” to sól', () => {
    const content = clone(example.content);
    const s4 = content.steps.find((s) => s.id === 's4')!;
    s4.body =
      'W drugim talerzu roztrzep jajko, do trzeciego wsyp bułkę tartą, dopraw do smaku.';
    expect(qualityChecks(kotlet, content).warnings).toContainEqual(
      expect.stringContaining('s4: składnik „mąka pszenna”'),
    );
    const s10 = content.steps.find((s) => s.id === 's10')!;
    s10.title = 'Zrób mizerię';
    s10.body =
      'Pokrój ogórek, posól, dodaj śmietanę i pieprz — serwuj od razu.';
    expect(
      qualityChecks(kotlet, content).warnings.filter((w) =>
        w.startsWith('s10: składnik'),
      ),
    ).toEqual([]);
    s10.body = 'Pokrój ogórek, dodaj śmietanę i pieprz — serwuj od razu.';
    expect(qualityChecks(kotlet, content).warnings).toContainEqual(
      expect.stringContaining('s10: składnik „sól”'),
    );
  });

  describe('składnik w tekście — człony nazwy i oboczności (review Codexa, runda 2)', () => {
    const words = (text: string) =>
      normalizeText(text)
        .split(/[^a-z]+/)
        .filter(Boolean);
    it.each([
      // [nazwa, tekst, wymieniony?]
      [
        'przyprawa do kurczaka',
        'Przygotuj kurczaka i przykryj go folią.',
        false,
      ],
      ['przyprawa do kurczaka', 'Natrzyj mięso przyprawą.', true],
      ['filet z kurczaka', 'Pokrój kurczaka w paski.', true],
      ['cukier', 'Dodaj cukru i wymieszaj.', true],
      ['ocet jabłkowy', 'Skrop buraki octem.', true],
      ['mąka pszenna', 'Obtocz kotlety w mące.', true],
      ['mąka pszenna', 'Dopraw do smaku.', false],
      ['ser feta', 'Serwuj od razu.', false],
      ['sól', 'Posól wodę.', true],
      ['koperek', 'Posyp resztą koperku.', true],
      // Runda 3 Codexa: samo określenie nie nazywa składnika.
      ['pieprz czarny', 'Dodaj czarną fasolę.', false],
      ['pieprz czarny', 'Dopraw pieprzem.', true],
      ['mąka pszenna', 'Wsyp pszenną bułkę.', false],
      ['ser feta', 'Pokrusz fetę.', true],
      ['sos sojowy', 'Skrop sosem sojowym.', true],
      // Pomiar na korpusie (runda 3): człon, który sam nazywa składnik.
      ['papryczka chili', 'Chili pokrój w cienkie kawałki.', true],
      ['nasiona chia', 'Ułóż pasek chia.', true],
      ['cebula dymka', 'Dymkę pokrój w plasterki.', true],
      ['makaron penne', 'Wrzuć penne do wrzątku.', true],
      ['ser twaróg półtłusty', 'Rozgnieć twaróg widelcem.', true],
      // Runda 4 Codexa: określenie za ogólnym rzeczownikiem nie nazywa rzeczy.
      ['cebula czerwona', 'Dodaj czerwoną paprykę.', false],
      ['sos pomidorowy', 'Wlej passatę pomidorową.', false],
      ['mleko kokosowe z puszki', 'Posyp wiórkami kokosowymi.', false],
      ['pestki dyni', 'Pokrój dynię w kostkę.', false],
      // Pomiar na 728 parach (runda 4): imiesłów, synonim, ser bez „ser”.
      ['sól', 'Wsyp ryż do osolonego wrzątku.', true],
      ['sól', 'Zagotuj wodę i osól ją.', true],
      ['sól', 'Podaj z sosem.', false],
      ['proszek do pieczenia', 'Oprósz formę mąką.', false],
      ['kmin rzymski', 'Dopraw kuminem.', true],
      ['mozzarella tarta', 'Posyp tortille połową sera.', true],
      ['makaron cannelloni', 'Napełnij rurki farszem.', true],
    ])('%s ← „%s” → %s', (name, text, expected) => {
      expect(ingredientNamed(name, words(text))).toBe(expected);
    });
  });

  it('wzorzec kotleta przechodzi też ostrzeżenia reguł .4/.5 (składniki w tekście, tytuł bez echa)', () => {
    const warnings = qualityChecks(kotlet, clone(example.content)).warnings;
    expect(
      warnings.filter((w) => /nie wymienia|powtórzenia tytułu/.test(w)),
    ).toEqual([]);
  });

  it('„W MIĘDZYCZASIE” tylko przy kroku z during (zasady .4)', () => {
    const content = clone(example.content);
    const withDuring = content.steps.find((step) => step.during);
    expect(withDuring).toBeDefined();
    withDuring!.stage = 'W MIĘDZYCZASIE';
    expect(
      qualityChecks(kotlet, content).errors.filter((e) =>
        e.includes('MIĘDZYCZASIE'),
      ),
    ).toEqual([]);
    const plain = content.steps.find((step) => !step.during)!;
    plain.stage = 'W MIĘDZYCZASIE';
    expect(qualityChecks(kotlet, content).errors).toContainEqual(
      expect.stringContaining(`${plain.id}.stage: „W MIĘDZYCZASIE” bez`),
    );
  });

  it('składnik z ilością, którego tekst kroku nie wymienia = ostrzeżenie; odmiana przechodzi', () => {
    const content = clone(example.content);
    const step = content.steps.find(
      (s) => s.ingredients.length > 0 && !s.timer,
    )!;
    const name = kotlet.ingredients.find(
      (row) => row.ingredientId === step.ingredients[0].ingredientId,
    )!.name;
    const others = step.ingredients
      .slice(1)
      .map(
        (use) =>
          kotlet.ingredients.find(
            (row) => row.ingredientId === use.ingredientId,
          )!.name,
      );
    step.title = 'Przygotuj';
    step.note = null;
    step.body = `Weź ${others.join(', ')} i odstaw.`;
    expect(qualityChecks(kotlet, content).warnings).toContainEqual(
      expect.stringContaining(`${step.id}: składnik „${name}”`),
    );
    // Odmiana i czasownik („posól”) to wymienienie składnika.
    step.body = `Weź ${others.join(', ')}, dodaj ${name.slice(0, 3)}ę i posól.`;
    expect(
      qualityChecks(kotlet, content).warnings.filter((w) =>
        w.startsWith(`${step.id}: składnik`),
      ),
    ).toEqual([]);
  });

  it('piekarnik użyty przed nagrzaniem = błąd', () => {
    const content = clone(example.content);
    const preheat = content.steps.findIndex((step) =>
      step.title.includes('Nagrzej'),
    );
    const [moved] = content.steps.splice(preheat, 1);
    content.steps.push(moved);
    expect(qualityChecks(kotlet, content).errors).toEqual([
      expect.stringContaining('piekarnik używany bez wcześniejszego kroku'),
    ]);
  });

  it('drób bez „po czym poznać” = błąd; przetworzony drób nie wymaga', () => {
    const content = clone(example.content);
    for (const step of content.steps) {
      step.body = step.body.replace(
        /74\s*°C|przezroczyst\w*|różow\w*/gi,
        'gotowe',
      );
      if (step.note) {
        step.note.text = step.note.text.replace(
          /74\s*°C|przezroczyst\w*|różow\w*/gi,
          'gotowe',
        );
      }
    }
    expect(qualityChecks(kotlet, content).errors).toEqual([
      expect.stringContaining('bezpieczeństwo (drób: „filet z kurczaka”)'),
    ]);

    const broth: WriterRecipe = {
      ...kotlet,
      ingredients: kotlet.ingredients.map((row) =>
        row.name === 'filet z kurczaka'
          ? { ...row, name: 'bulion drobiowy' }
          : row,
      ),
    };
    expect(
      qualityChecks(broth, content).errors.filter((e) =>
        e.includes('bezpieczeństwo'),
      ),
    ).toEqual([]);
  });

  it('timer z czasem spoza przepisu = błąd, czas przepisu bez timera = ostrzeżenie', () => {
    const content = clone(example.content);
    const withTimer = content.steps.find(
      (step) => step.timer?.id === 't-oven',
    )!;
    withTimer.timer!.minSeconds = 1800;
    withTimer.timer!.maxSeconds = 1800;
    content.totalMinutes = 60; // osobno od reguły czasu całości
    const result = qualityChecks(kotlet, content);
    expect(result.errors).toEqual([
      expect.stringContaining('takiego czasu nie ma w przepisie'),
    ]);

    const noTimer = clone(example.content);
    const potatoes = noTimer.steps.find(
      (step) => step.timer?.id === 't-potatoes',
    )!;
    potatoes.timer = null;
    for (const step of noTimer.steps) {
      if (step.during === 't-potatoes') step.during = null;
    }
    expect(qualityChecks(kotlet, noTimer).warnings).toContain(
      'czas z przepisu 1200 s nie ma timera',
    );
  });

  it('recipeDurations czyta zakresy, godziny i słowa', () => {
    expect(
      recipeDurations([
        'Smaż 10–12 minut, potem 1,5 godz. w piekarniku.',
        'Odstaw na kwadrans, a ciasto na godzinę.',
        'Gotuj 5 do 7 min.',
      ]),
    ).toEqual([
      [600, 720],
      [5400, 5400],
      [900, 900],
      [3600, 3600],
      [300, 420],
    ]);
  });

  it('„po X min z każdej strony” = dwa odliczania; łączny wariant tylko bez patelni', () => {
    // Smażenie: stoi się przy patelni — tylko dwa odliczania po X.
    expect(
      recipeDurations([
        'Smaż rybę po 3 minuty z każdej strony.',
        'Gotuj 5 min.',
      ]),
    ).toEqual([
      [180, 180],
      [180, 180],
      [300, 300],
    ]);
    expect(recipeDurations(['Opiekaj 2 min na patelni z obu stron.'])).toEqual([
      [120, 120],
      [120, 120],
    ]);
    // Pieczenie: dwa po X albo jedno łączne 2X.
    expect(
      recipeDurations(['Piecz placki po 5 minut z każdej strony.']),
    ).toEqual([
      [300, 300],
      [300, 300],
      [600, 600],
    ]);
    // Skrót „ok.” nie kończy zdania — to wciąż smażenie (test paczek E3b).
    expect(
      recipeDurations(['Ułóż gruszkę i smaż ok. 2 minuty z każdej strony.']),
    ).toEqual([
      [120, 120],
      [120, 120],
    ]);
    // Nowe zdanie po kropce — smażenie z poprzedniego już nie liczy się.
    expect(
      recipeDurations(['Smaż cebulę. Piecz placki po 5 min z każdej strony.']),
    ).toEqual([
      [300, 300],
      [300, 300],
      [600, 600],
    ]);
  });

  it('tekst „po 2 minuty z każdej strony” nie twierdzi, że coś trwa 4 minuty', () => {
    // Sam ten krok przepisu — żadne inne „4 minuty” nie uzasadnią czasu.
    const recipe: WriterRecipe = {
      ...kotlet,
      instructions: [
        'Na patelni rozpuść masło i smaż gruszkę 2 minuty z każdej strony.',
      ],
    };
    for (const body of [
      'Rozpuść masło na patelni. Ułóż gruszkę i smaż ok. 2 minuty z każdej strony.',
      'Ułóż gruszkę i piecz ok. 2 minuty z każdej strony.',
    ]) {
      const content = clone(example.content);
      const step = content.steps.find(
        (st) =>
          !st.timer &&
          !st.during &&
          !/piekarnik/i.test(st.title) &&
          /smaż|patel/i.test(st.body),
      )!;
      step.body = body;
      expect(
        qualityChecks(recipe, content).errors.filter((e) =>
          e.startsWith(`${step.id}:`),
        ),
      ).toEqual([]);
    }
  });

  it('SKIP dozwolony tylko dla przepisu bez czasów i krótkiego', () => {
    expect(skipGuard(kotlet)).toContain('SKIP niedozwolony');
    expect(
      skipGuard({
        ...kotlet,
        title: 'Jogurt z granolą',
        equipment: [],
        prepTimeMinutes: 5,
        instructions: [
          'Jogurt przełóż do miseczki.',
          'Posyp granolą i owocami.',
        ],
      }),
    ).toBeNull();
  });
  describe('bezpieczeństwo: tylko twierdzące „po czym poznać”', () => {
    // Wzorzec ma sygnał w adnotacji kroku s9; podmieniamy ją na próbę.
    const withCue = (text: string) => {
      const content = clone(example.content);
      const step = content.steps.find((s) => s.id === 's9')!;
      step.note = { kind: 'CUE', text };
      return qualityChecks(kotlet, content).errors.filter((e) =>
        e.includes('bezpieczeństwo'),
      );
    };

    it.each([
      'Mięso może zostać lekko różowe w środku.',
      'Podawaj z różowym sosem.',
      'Sok nie jest jeszcze przezroczysty — to normalne.',
      'Nie musi mieć 74°C, wystarczy kolor.',
    ])('„%s” nie wystarcza', (text) => {
      expect(withCue(text)).toEqual([
        expect.stringContaining('bezpieczeństwo (drób: „filet z kurczaka”)'),
      ]);
    });

    it.each([
      'Przekrój: w środku bez różowego.',
      'Mięso nie jest już różowe, sok przezroczysty.',
      'Termometr pokazuje 74°C w środku.',
      'Po nakłuciu wypływa przezroczysty sok.',
    ])('„%s” wystarcza', (text) => {
      expect(withCue(text)).toEqual([]);
    });

    it('sygnał sprzed kroku, w którym surowiec wchodzi do pracy, się nie liczy', () => {
      const content = clone(example.content);
      content.steps.find((s) => s.id === 's9')!.note = null;
      content.steps[0].note = {
        kind: 'TIP',
        text: 'Kurczak ma być bez różowego w środku.',
      };
      expect(
        qualityChecks(kotlet, content).errors.filter((e) =>
          e.includes('bezpieczeństwo'),
        ),
      ).toHaveLength(1);
    });
  });
  it('SKIP: krótki przepis z obróbką bez liczby albo ze sprzętem jest zablokowany', () => {
    const yogurt: WriterRecipe = {
      ...kotlet,
      title: 'Jogurt z granolą',
      equipment: [],
      prepTimeMinutes: 5,
      instructions: ['Jogurt przełóż do miseczki.', 'Posyp granolą i owocami.'],
    };
    expect(skipGuard(yogurt)).toBeNull();
    expect(skipGuard({ ...yogurt, equipment: ['BLENDER'] })).toBeNull();
    expect(
      skipGuard({
        ...yogurt,
        title: 'Omlet',
        instructions: ['Jajka roztrzep z solą.', 'Smaż na maśle do ścięcia.'],
      }),
    ).toContain('„Smaż”');
    expect(skipGuard({ ...yogurt, equipment: ['OVEN'] })).toContain('OVEN');
  });

  describe('czasy i temperatury w tekście mają pokrycie', () => {
    const cutlets = () => {
      const content = clone(example.content);
      return {
        content,
        step: content.steps.find((s) => s.timer?.id === 't-cutlets')!,
      };
    };

    it('tekst przeczy timerowi kroku = błąd, choć timer zgodny z przepisem', () => {
      const { content, step } = cutlets();
      step.body = 'Smaż 30 minut, obracając.';
      expect(qualityChecks(kotlet, content).errors).toEqual([
        expect.stringContaining('tekst i timer muszą się zgadzać'),
      ]);
    });

    it('temperatura spoza przepisu = błąd; temperatura bezpieczeństwa przechodzi', () => {
      const { content, step } = cutlets();
      step.body = 'Rozgrzej olej do 220°C i smaż, obracając.';
      expect(qualityChecks(kotlet, content).errors).toEqual([
        expect.stringContaining('temperatury 220°C nie ma w przepisie'),
      ]);
      step.body = 'Smaż, aż w środku będzie 74°C.';
      expect(qualityChecks(kotlet, content).errors).toEqual([]);
    });

    it('czas bez pokrycia w kroku bez timera = błąd, krótki = ostrzeżenie', () => {
      const content = clone(example.content);
      const plain = content.steps.find(
        (s) => !s.timer && !s.during && !/Nagrzej/.test(s.title),
      )!;
      plain.body = 'Odstaw na 30 minut.';
      expect(qualityChecks(kotlet, content).errors).toEqual([
        expect.stringContaining(`${plain.id}: czasu 1800 s nie ma w przepisie`),
      ]);
      plain.body = 'Mieszaj 1 minutę.';
      const result = qualityChecks(kotlet, content);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toContain(
        `${plain.id}: krótki czas 60 s spoza przepisu`,
      );
    });

    it('jedno wystąpienie czasu w przepisie nie uzasadni dwóch timerów', () => {
      const content = clone(example.content);
      const potatoes = content.steps.find((s) => s.timer?.id === 't-potatoes')!;
      const other = content.steps.find((s) => s.id === 's4')!;
      other.timer = { ...potatoes.timer!, id: 't-copy' };
      expect(qualityChecks(kotlet, content).errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('przepis ma ten czas mniej razy'),
        ]),
      );
    });
  });
  describe('bezpieczeństwo: co jest surowe, a co gotowe do jedzenia', () => {
    // Wzorzec bez żadnego sygnału „gotowe” — liczy się tylko, czy reguła
    // w ogóle obejmuje składnik.
    const noCue = () => {
      const content = clone(example.content);
      content.steps.find((s) => s.id === 's9')!.note = null;
      return content;
    };
    const safetyErrors = (name: string) =>
      qualityChecks(
        {
          ...kotlet,
          ingredients: kotlet.ingredients.map((row) =>
            row.name === 'filet z kurczaka' ? { ...row, name } : row,
          ),
        },
        noCue(),
      ).errors.filter((e) => e.includes('bezpieczeństwo'));

    it.each([
      ['kurczak marynowany w jogurcie', 'drób'],
      ['udko z kurczaka w sosie', 'drób'],
      ['wątróbka drobiowa', 'drób'],
      ['wieprzowina mielona', 'mięso mielone'],
      ['łosoś', 'ryba'],
    ])('„%s” wymaga „po czym poznać” (%s)', (name, label) => {
      expect(safetyErrors(name)).toEqual([
        expect.stringContaining(`bezpieczeństwo (${label}: „${name}”)`),
      ]);
    });

    it.each([
      'papryka słodka mielona',
      'imbir mielony',
      'tuńczyk w puszce',
      'łosoś wędzony',
      'wędlina drobiowa',
      'bulion drobiowy',
      'sardynka w oleju',
    ])('„%s” nie wymaga', (name) => {
      expect(safetyErrors(name)).toEqual([]);
    });
  });
  describe('bezpieczeństwo: sygnał przy właściwym surowcu i dział katalogu', () => {
    const turkey = {
      ingredientId: 'filet z indyka',
      name: 'filet z indyka',
      amount: 200,
      unit: 'g',
      department: 'Mięso',
    };
    const withTurkey: WriterRecipe = {
      ...kotlet,
      ingredients: [...kotlet.ingredients, turkey],
    };
    const turkeyStep = (body: string) => ({
      ...clone(example.content.steps[7]),
      id: 's13',
      title: 'Usmaż indyka osobno',
      body,
      ingredients: [
        {
          ingredientId: turkey.ingredientId,
          amount: 200,
          unit: 'g',
          part: 'ALL' as const,
        },
      ],
      mentions: [],
      note: null,
      timer: null,
      during: null,
    });
    const safety = (recipe: WriterRecipe, content: Content) =>
      qualityChecks(recipe, content).errors.filter((e) =>
        e.includes('bezpieczeństwo'),
      );

    it('dwa mięsa smażone osobno: sygnał tylko przy kurczaku nie zalicza indyka', () => {
      const content = clone(example.content);
      content.steps.push(turkeyStep('Smaż na złoto z obu stron.'));
      expect(safety(withTurkey, content)).toEqual([
        expect.stringContaining('„filet z indyka”'),
      ]);
    });

    it('…i odwrotnie: sygnał tylko przy indyku nie zalicza kurczaka', () => {
      const content = clone(example.content);
      content.steps.find((s) => s.id === 's9')!.note = null;
      content.steps.push(turkeyStep('Smaż, aż w środku będzie 74°C.'));
      expect(safety(withTurkey, content)).toEqual([
        expect.stringContaining('„filet z kurczaka”'),
      ]);
    });

    const noCueErrors = (name: string, department: string | null) => {
      const content = clone(example.content);
      content.steps.find((s) => s.id === 's9')!.note = null;
      return safety(
        {
          ...kotlet,
          ingredients: kotlet.ingredients.map((row) =>
            row.name === 'filet z kurczaka'
              ? { ...row, name, department }
              : row,
          ),
        },
        content,
      );
    };

    it.each([
      ['surowa kiełbasa drobiowa', 'Mięso'],
      ['kiełbasa drobiowa', 'Mięso'],
      ['kurczak do gotowania', 'Mięso'],
      ['szynka z indyka surowa', 'Mięso'],
      ['łosoś', 'Mrożonki'],
      ['filet z kurczaka', null],
    ])('„%s” (%s) wymaga sygnału', (name, department) => {
      expect(noCueErrors(name, department)).toHaveLength(1);
    });

    it.each([
      ['tuńczyk w puszce', 'Konserwy'],
      ['bulion drobiowy', 'Konserwy'],
      ['papryka słodka mielona', 'Przyprawy i sosy'],
      ['szynka z indyka', 'Mięso'],
      ['wędlina drobiowa', 'Mięso'],
      ['łosoś wędzony', 'Ryby'],
    ])('„%s” (%s) nie wymaga', (name, department) => {
      expect(noCueErrors(name, department)).toEqual([]);
    });
  });
  describe('liczby z jednostką przepisane z kroków przepisu', () => {
    const cheesecake: WriterRecipe = {
      ...kotlet,
      instructions: [
        ...kotlet.instructions,
        'Żelatynę zalej 100 ml zimnej wody, a masę przełóż do naczynia ok. 1,5 l.',
      ],
    };
    const withBody = (recipe: WriterRecipe, body: string) => {
      const content = clone(example.content);
      content.steps[1].body = body;
      return qualityChecks(recipe, content).errors;
    };

    it('ilość spoza listy składników, dosłownie z przepisu, przechodzi', () => {
      expect(
        withBody(
          cheesecake,
          'Zalej żelatynę 100 ml zimnej wody, przełóż do naczynia ok. 1,5 l.',
        ),
      ).toEqual([]);
    });

    it('ta sama liczba spoza przepisu nie przechodzi', () => {
      expect(withBody(kotlet, 'Zalej żelatynę 100 ml zimnej wody.')).toEqual([
        expect.stringContaining('liczba „100”'),
      ]);
    });

    it('ilość składnika z listy nie przechodzi, nawet gdy stoi w przepisie', () => {
      const withAmount: WriterRecipe = {
        ...kotlet,
        instructions: [...kotlet.instructions, 'Rozbij 320 g filetu.'],
      };
      expect(withBody(withAmount, 'Rozbij 320 g filetu na kotlety.')).toEqual([
        expect.stringContaining('liczba „320”'),
      ]);
    });
  });
  describe('układ timerów po ludzku (decyzje z 30.09)', () => {
    const errorsOf = (content: Content) =>
      qualityChecks(kotlet, content).errors;

    it('timer krótszy niż 4 min = błąd (krótką czynność opisz tekstem)', () => {
      const content = clone(example.content);
      const oven = content.steps.find((s) => s.timer?.id === 't-oven')!;
      oven.timer = { ...oven.timer!, minSeconds: 180, maxSeconds: 180 };
      expect(errorsOf(content)).toEqual(
        expect.arrayContaining([expect.stringContaining('krótsze niż 4 min')]),
      );
    });

    it('trzecie odliczanie naraz = błąd', () => {
      const content = clone(example.content);
      // s4 startuje w trakcie ziemniaków, które startują w trakcie masła.
      const s4 = content.steps.find((s) => s.id === 's4')!;
      s4.during = 't-potatoes';
      s4.timer = { ...content.steps[8].timer!, id: 't-third' };
      expect(errorsOf(content)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('3. odliczanie naraz'),
        ]),
      );
    });

    it('dwa odliczania pod jednym timerem — jedna semantyka: pełny zestaw błędów (review Codexa, noc 1.10)', () => {
      const content = clone(example.content);
      // Pod masłem (15 min): krótkie odliczanie s2 i ziemniaki s3.
      const s2 = content.steps.find((s) => s.id === 's2')!;
      s2.timer = {
        ...content.steps[0].timer!,
        id: 't-a',
        label: 'Bułka',
        minSeconds: 300,
        maxSeconds: 300,
      };
      const withRecipe = {
        ...kotlet,
        instructions: [...kotlet.instructions, 'Odstaw na 5 minut.'],
      };
      const timeline = qualityChecks(withRecipe, content).errors.filter((e) =>
        /odliczani|naraz/.test(e),
      );
      expect(timeline).toEqual([
        expect.stringContaining('w tej chwili biegną już 2 odliczania'),
        expect.stringContaining('pod nim 2 kroki z własnym odliczaniem'),
      ]);
    });

    it('krok nagrzewania bez trybu piekarnika = błąd', () => {
      const content = clone(example.content);
      const preheat = content.steps.find((s) => s.title.startsWith('Nagrzej'))!;
      preheat.body = 'Za kwadrans kotlety trafią do środka na 5 minut.';
      expect(errorsOf(content)).toEqual([
        expect.stringContaining('nie mówi, jak ustawić piekarnik'),
      ]);
    });
  });
  it('pisownia: słowa kuchenne bez polskich znaków = błąd z poprawną formą (D32)', () => {
    const content = clone(example.content);
    content.steps[1].body =
      'Kroj mieso równo i poloz na desce razem z resztą. Cebule po przekrojeniu posiekaj, dodaj ze soli od razu.';
    expect(qualityChecks(kotlet, content).errors).toEqual([
      's2.body: pisownia „Kroj” → „krój”',
      's2.body: pisownia „mieso” → „mięso”',
      's2.body: pisownia „poloz” → „połóż”',
    ]);
  });
  it('aktywne smażenie „po 4 min z każdej strony” — łącznego timera 8 min NIE ma; pieczenie „po 5 min” — łączny 10 min jest', () => {
    const withTimer = (instruction: string, seconds: number) => {
      const recipe: WriterRecipe = {
        ...kotlet,
        instructions: [...kotlet.instructions, instruction],
      };
      const content = clone(example.content);
      content.steps.find((st) => st.id === 's12')!.timer = {
        ...content.steps[8].timer!,
        id: 't-side',
        label: 'Strona',
        minSeconds: seconds,
        maxSeconds: seconds,
      };
      return qualityChecks(recipe, content).errors.filter((e) =>
        e.includes('nie ma w przepisie'),
      );
    };
    expect(withTimer('Smaż rybę po 4 minuty z każdej strony.', 480)).toEqual([
      expect.stringContaining('takiego czasu nie ma w przepisie'),
    ]);
    expect(withTimer('Piecz placki po 5 minut z każdej strony.', 600)).toEqual(
      [],
    );
  });

  it('„po X min z każdej strony”: dwa odliczania ALBO jedno łączne — oba naraz = błąd', () => {
    const recipe: WriterRecipe = {
      ...kotlet,
      instructions: [
        ...kotlet.instructions,
        'Piecz kotlety po 5 minut z każdej strony.',
      ],
    };
    const withTimers = (seconds: number[]) => {
      const content = clone(example.content);
      const free = content.steps
        .filter((st) => !st.timer && !st.during)
        .slice(0, seconds.length);
      free.forEach((st, i) => {
        st.timer = {
          ...content.steps[8].timer!,
          id: `t-side-${i}`,
          label: 'Strona',
          minSeconds: seconds[i],
          maxSeconds: seconds[i],
        };
      });
      // Błąd może trafić w „stronę” albo w zwykły czas, który stracił timer.
      return qualityChecks(recipe, content).errors.filter(
        (e) => e.includes('z każdej strony') || e.includes('mniej razy'),
      );
    };
    expect(withTimers([300, 300])).toEqual([]);
    expect(withTimers([600])).toEqual([]);
    expect(withTimers([300, 300, 600])).toHaveLength(1);
    // Jedno odliczanie „po stronie” = połowa smażenia.
    expect(withTimers([300])).toEqual([
      expect.stringContaining('tylko dla jednej strony'),
    ]);

    // Zwykły czas o tej samej długości NIE jest brany za „stronę”.
    const alsoPlain: WriterRecipe = {
      ...recipe,
      instructions: [...recipe.instructions, 'Odstaw na 5 minut.'],
    };
    const withTimersPlain = (seconds: number[]) => {
      const content = clone(example.content);
      const free = content.steps
        .filter((st) => !st.timer && !st.during)
        .slice(0, seconds.length);
      free.forEach((st, i) => {
        st.timer = {
          ...content.steps[8].timer!,
          id: `t-plain-${i}`,
          label: 'Czas',
          minSeconds: seconds[i],
          maxSeconds: seconds[i],
        };
      });
      return qualityChecks(alsoPlain, content).errors.filter(
        (e) => e.includes('z każdej strony') || e.includes('mniej razy'),
      );
    };
    expect(withTimersPlain([300])).toEqual([]);
    expect(withTimersPlain([300, 300, 300])).toEqual([]);
  });
  it('częściowa ilość składnika z przepisu („100 ml mleka” z 200 ml) nie może stać w tekście; naczynie i woda spoza listy — mogą', () => {
    const withMilk: WriterRecipe = {
      ...kotlet,
      ingredients: [
        ...kotlet.ingredients,
        { ingredientId: 'mleko', name: 'mleko', amount: 200, unit: 'ml' },
      ],
      instructions: [
        ...kotlet.instructions,
        'Wlej 100 ml mleka do rondla i wstaw naczynie ok. 1,5 l, dolej 100 ml zimnej wody.',
      ],
    };
    const withBody = (body: string) => {
      const content = clone(example.content);
      content.steps[1].body = body;
      return qualityChecks(withMilk, content).errors.filter((e) =>
        e.includes('liczba'),
      );
    };
    expect(withBody('Wlej 100 ml mleka do rondla.')).toEqual([
      expect.stringContaining('liczba „100”'),
    ]);
    // Rzeczownik po przymiotnikach — dalej ilość składnika.
    expect(
      withBody('Wlej 100 ml świeżo przegotowanego, zimnego mleka.'),
    ).toEqual([expect.stringContaining('liczba „100”')]);
    expect(
      withBody('Przygotuj naczynie ok. 1,5 l i dolej 100 ml zimnej wody.'),
    ).toEqual([]);
  });

  it('pod jednym timerem najwyżej jeden krok z własnym odliczaniem (inaczej potencjalnie trzy naraz)', () => {
    const content = clone(example.content);
    const s2 = content.steps.find((st) => st.id === 's2')!;
    s2.timer = {
      ...content.steps[0].timer!,
      id: 't-sibling',
      minSeconds: 300,
      maxSeconds: 300,
    };
    const errors = qualityChecks(kotlet, content).errors;
    expect(errors).toEqual(
      expect.arrayContaining([expect.stringContaining('najwyżej jeden')]),
    );
  });
  it('ilość przy SĄSIEDNIM słowie-składniku to nie ilość składnika („naczynie 1,5 l wysmaruj masłem”, „bulion i 300 ml wody”)', () => {
    const recipe: WriterRecipe = {
      ...kotlet,
      ingredients: [
        ...kotlet.ingredients,
        {
          ingredientId: 'bulion',
          name: 'bulion warzywny',
          amount: 800,
          unit: 'ml',
        },
      ],
      instructions: [
        ...kotlet.instructions,
        'Naczynie o pojemności ok. 1,5 l wysmaruj masłem. Wlej bulion i 300 ml wody.',
        'Z mąki, ciepłej wody (100 ml), bulionu i soli zagnieć ciasto.',
      ],
    };
    const content = clone(example.content);
    content.steps[1].body =
      'Naczynie ok. 1,5 l wysmaruj masłem. Wlej bulion i 300 ml wody, zagotuj. Dodaj 100 ml ciepłej wody.';
    expect(
      qualityChecks(recipe, content).errors.filter((e) => e.includes('liczba')),
    ).toEqual([]);
  });
  describe('oś czasu: najwyżej dwa odliczania naraz (kontrakt przy CookStep.during)', () => {
    const errorsOf = (content: Content) =>
      qualityChecks(kotlet, content).errors.filter((e) =>
        e.includes('biegną już'),
      );

    it('wzorzec kotleta: ziemniaki zachodzą na smażenie — dwa naraz, w porządku', () => {
      expect(errorsOf(clone(example.content))).toEqual([]);
    });

    it('kolejne kroki główne z timerami idą po sobie (każdy czeka na koniec poprzedniego)', () => {
      const content = clone(example.content);
      // s5 (nagrzewanie, krok główny) dostaje własny timer — zaczyna się po
      // maśle, więc biegnie obok ziemniaków: dwa naraz.
      content.steps.find((st) => st.id === 's5')!.timer = {
        ...content.steps[8].timer!,
        id: 't-preheat',
      };
      expect(errorsOf(content)).toEqual([]);
    });

    it('kolejne kroki główne z timerami o zakresach („10–12 min”) nie liczą się jako równoczesne', () => {
      const content = clone(example.content);
      // Trzy kroki główne pod rząd, każdy z zakresem — każdy rusza po alarmie
      // poprzedniego, więc naraz biegnie najwyżej jeden (+ ziemniaki).
      const range = { minSeconds: 600, maxSeconds: 720 };
      for (const id of ['s5', 's6', 's7']) {
        content.steps.find((st) => st.id === id)!.timer = {
          ...content.steps[7].timer!,
          ...range,
          id: `t-${id}`,
        };
      }
      expect(errorsOf(content)).toEqual([]);
    });

    it('trzecie odliczanie naraz: długie ziemniaki + piekarnik + odliczanie „w międzyczasie” pod piekarnikiem = błąd', () => {
      const content = clone(example.content);
      // Ziemniaki (z „w międzyczasie” pod masłem) gotują się tak długo, że
      // biegną jeszcze przy piekarniku; pod piekarnikiem trzecie odliczanie.
      const potatoes = content.steps.find(
        (st) => st.timer?.id === 't-potatoes',
      )!;
      potatoes.timer = { ...potatoes.timer!, maxSeconds: 3600 };
      const s10 = content.steps.find((st) => st.id === 's10')!;
      s10.during = 't-oven';
      s10.timer = { ...content.steps[8].timer!, id: 't-third' };
      expect(errorsOf(content)).toEqual([expect.stringContaining('s10.timer')]);
    });
  });

  describe('zasady .6 — przegląd całego systemu (Codex, noc 30.09)', () => {
    const step = (content: Content, id: string) =>
      content.steps.find((st) => st.id === id)!;

    it('splitRecipeVariants: zdanie „W piekarniku: …” to drugi wariant, reszta linii zostaje', () => {
      expect(
        splitRecipeVariants([
          'Piecz w airfryerze w 170°C 12–14 minut, aż się zrumienią. W piekarniku: 190°C, 20–22 minuty na blasze. Wymieszaj skyr.',
          'Podawaj od razu.',
        ]),
      ).toEqual({
        primary: [
          'Piecz w airfryerze w 170°C 12–14 minut, aż się zrumienią. Wymieszaj skyr.',
          'Podawaj od razu.',
        ],
        alternative: ['W piekarniku: 190°C, 20–22 minuty na blasze.'],
      });
    });

    it('czas i temperatura DRUGIEGO wariantu: w timerze i kroku błąd z podpowiedzią, w radzie wolno', () => {
      const recipe: WriterRecipe = {
        ...kotlet,
        instructions: kotlet.instructions.map((line, i) =>
          i === 4 ? `${line} W piekarniku: 200°C, 8 minut.` : line,
        ),
      };
      const good = clone(example.content);
      good.tips = [
        ...good.tips.slice(0, 2),
        'Bez patelni: w piekarniku 200°C, 8 minut.',
      ];
      expect(qualityChecks(recipe, good).errors).toEqual([]);

      const mixed = clone(example.content);
      const oven = mixed.steps.find((st) => st.timer?.id === 't-oven')!;
      oven.timer = { ...oven.timer!, minSeconds: 480, maxSeconds: 480 };
      oven.body = `${oven.body} Ustaw 200°C.`;
      const errors = qualityChecks(recipe, mixed).errors;
      expect(errors).toContainEqual(
        expect.stringMatching(/timer.*DRUGIEGO wariantu/),
      );
      expect(errors).toContainEqual(
        expect.stringMatching(/temperatury 200°C.*DRUGIEGO wariantu/),
      );
    });

    it('part: jeden krok = ALL; podzielony bez ALL; HALF = połowa; REST tylko na końcu', () => {
      const errorsFor = (mutate: (content: Content) => void) => {
        const content = clone(example.content);
        mutate(content);
        return qualityChecks(kotlet, content).errors;
      };
      expect(
        errorsFor((c) => {
          step(c, 's4').ingredients[0].part = 'PART';
        }),
      ).toContainEqual(
        expect.stringContaining(
          's4: „mąka pszenna” trafia do dania tylko w tym kroku',
        ),
      );
      expect(
        errorsFor((c) => {
          step(c, 's2').ingredients[1].part = 'ALL';
        }),
      ).toContainEqual(expect.stringContaining('s2: „sól” jest podzielony'));
      expect(
        errorsFor((c) => {
          step(c, 's2').ingredients[2].amount = 0.7;
          step(c, 's10').ingredients[3].amount = 0.3;
        }),
      ).toContainEqual(
        expect.stringContaining('s2: „pieprz czarny” HALF, a to 70% ilości'),
      );
      expect(
        errorsFor((c) => {
          step(c, 's1').ingredients[1].part = 'REST';
          step(c, 's11').ingredients[0].part = 'HALF';
        }),
      ).toContainEqual(
        expect.stringContaining(
          's1: „koperek” REST (reszta), a składnik wraca',
        ),
      );
    });

    it('during tylko pod timerem, który w tym miejscu jeszcze biegnie', () => {
      const content = clone(example.content);
      // Masło skończyło się, zanim ruszyły kroki główne s5+.
      step(content, 's10').during = 't-butter';
      expect(qualityChecks(kotlet, content).errors).toContainEqual(
        expect.stringContaining(
          's10.during „t-butter”: ten timer w tym miejscu już nie biegnie',
        ),
      );
    });

    it('during pod zagnieżdżonym timerem: ziemniaki (spod masła) biegną dalej po krokach głównych — wolno; skończone — błąd', () => {
      const content = clone(example.content);
      // Ziemniaki startują „w międzyczasie” masła (0 → 20 min); s6 rusza po
      // maśle (15 min) — ziemniaki jeszcze się gotują.
      step(content, 's6').during = 't-potatoes';
      step(content, 's6').stage = 'W MIĘDZYCZASIE';
      const during = () =>
        qualityChecks(kotlet, content).errors.filter((e) =>
          e.includes('.during'),
        );
      expect(during()).toEqual([]);
      // Ziemniaki gotowe po 10 min — w 15. minucie już nie biegną.
      const potatoes = step(content, 's3').timer!;
      potatoes.minSeconds = 600;
      potatoes.maxSeconds = 600;
      expect(during()).toEqual([
        expect.stringContaining('s6.during „t-potatoes”'),
      ]);
    });

    it('dosłowna ilość spoza listy wolno, choć składnik ma tę samą ilość (próba .6: gulasz, pudding chia)', () => {
      const numberErrors = (recipe: WriterRecipe, body: string) => {
        const content = clone(example.content);
        step(content, 's12').body = body;
        return qualityChecks(recipe, content).errors.filter((e) =>
          /liczba „(300|150)”/.test(e),
        );
      };
      const gulasz: WriterRecipe = {
        ...kotlet,
        ingredients: [
          ...kotlet.ingredients,
          {
            ingredientId: 'passata',
            name: 'passata pomidorowa',
            amount: 300,
            unit: 'ml',
          },
        ],
        instructions: [
          ...kotlet.instructions,
          'Wlej bulion warzywny i 300 ml wody, zagotuj i gotuj pod przykryciem.',
        ],
      };
      expect(numberErrors(gulasz, 'Wlej bulion i 300 ml wody.')).toEqual([]);
      expect(numberErrors(gulasz, 'Wlej 300 ml passaty.')).toHaveLength(1);
      const pudding: WriterRecipe = {
        ...kotlet,
        ingredients: [
          ...kotlet.ingredients,
          {
            ingredientId: 'mleko-k',
            name: 'mleko kokosowe z puszki',
            amount: 150,
            unit: 'ml',
          },
        ],
        instructions: [
          ...kotlet.instructions,
          'Nasiona chia wymieszaj w słoiku z mlekiem kokosowym, 150 ml wody i cynamonem.',
        ],
      };
      expect(
        numberErrors(
          pudding,
          'Wymieszaj chia z mlekiem, 150 ml wody i cynamonem.',
        ),
      ).toEqual([]);
      // Przegląd nocny: ilość SKŁADNIKA przemycona bez rzeczownika,
      // w nawiasie, po przecinku albo synonimem — dalej błąd.
      for (const body of [
        'Wlej passatę (300 ml) i wymieszaj.',
        'Wlej passatę, 300 ml.',
        'Passata: 300 ml.',
        'Wlej 300 ml i zagotuj.',
        'Wlej 300 ml przecieru.',
      ]) {
        expect(numberErrors(gulasz, body)).toHaveLength(1);
      }
    });

    it('„120 ml letniej wody i oliwę” (lahmacun) — ilość wody, nie oliwy; „2 g soli i pieprz” — dalej błąd; „do 5 dni” to czas', () => {
      const recipe: WriterRecipe = {
        ...kotlet,
        ingredients: [
          ...kotlet.ingredients,
          {
            ingredientId: 'oliwa',
            name: 'oliwa z oliwek',
            amount: 15,
            unit: 'ml',
          },
        ],
        instructions: [
          ...kotlet.instructions,
          'Wymieszaj mąkę, dolej letnią wodę (120 ml) i oliwę. Przechowuj do 5 dni.',
        ],
      };
      const numberErrors = (body: string) => {
        const content = clone(example.content);
        step(content, 's12').body = body;
        return qualityChecks(recipe, content).errors.filter((e) =>
          e.includes('liczba'),
        );
      };
      expect(numberErrors('Dolej 120 ml letniej wody i oliwę.')).toEqual([]);
      expect(numberErrors('Wytrzymają do 5 dni.')).toEqual([]);
      expect(numberErrors('Dodaj 2 g soli i pieprz.')).toHaveLength(1);
    });

    it('jednostka „g” to nie „godzinę” — „cynamon (1 g)” nie przechodzi przez „odstaw na 1 godzinę”', () => {
      const recipe: WriterRecipe = {
        ...kotlet,
        ingredients: [
          ...kotlet.ingredients,
          { ingredientId: 'cynamon', name: 'cynamon', amount: 1, unit: 'g' },
        ],
        instructions: [...kotlet.instructions, 'Odstaw ciasto na 1 godzinę.'],
      };
      const content = clone(example.content);
      step(content, 's12').body = 'Dodaj cynamon (1 g).';
      expect(
        qualityChecks(recipe, content).errors.filter((e) =>
          e.includes('liczba „1”'),
        ),
      ).toHaveLength(1);
    });

    it('praca w turach („piecz po 2 naraz”): do trzech timerów tej samej długości wolno, cztery — nie', () => {
      const recipe: WriterRecipe = {
        ...kotlet,
        instructions: kotlet.instructions.map((line, i) =>
          i === 4 ? `${line} Placki piecz po 2 naraz przez 8–10 minut.` : line,
        ),
      };
      const withTurns = (count: number) => {
        const content = clone(example.content);
        const turns = ['s6', 's10', 's11', 's12'].slice(0, count);
        for (const id of turns) {
          step(content, id).timer = {
            ...content.steps[7].timer!,
            id: `t-${id}`,
            label: 'Placki',
            minSeconds: 480,
            maxSeconds: 600,
          };
          step(content, id).during = null;
          step(content, id).stage = null;
        }
        content.totalMinutes = 120;
        return qualityChecks(recipe, content).errors.filter((e) =>
          /mniej razy|takiego czasu/.test(e),
        );
      };
      expect(withTurns(2)).toEqual([]);
      expect(withTurns(3)).toEqual([]);
      expect(withTurns(4)).toHaveLength(1);
    });

    it('„wlewaj partiami po chochli” to dolewanie, nie tury — drugi timer 25 min nie przejdzie', () => {
      const pool = recipeDurationPool([
        'Bulion wlewaj partiami po chochli, mieszając i gotując na małym ogniu około 25 minut.',
      ]);
      expect(pool.ranges).toEqual([[1500, 1500]]);
      expect([...pool.extraTurns]).toEqual([]);
    });

    it('tury i „z każdej strony” w jednym zdaniu nie psują grupy stron', () => {
      const pool = recipeDurationPool([
        'Smaż partiami po 3 minuty z każdej strony, aż będą złote.',
      ]);
      // Tylko grupa stron (dwa odliczania po 3 min, bez łącznego — patelnia).
      expect(pool.ranges).toEqual([
        [180, 180],
        [180, 180],
      ]);
      expect(pool.perSide).toEqual([{ singles: [0, 1], combined: null }]);
      expect([...pool.extraTurns]).toEqual([]);
    });

    describe('ilości w tekście — trzeci przegląd nocny (przepisy z katalogu)', () => {
      const withRecipe = (
        ingredients: WriterRecipe['ingredients'],
        line: string,
      ): WriterRecipe => ({
        ...kotlet,
        ingredients: [...kotlet.ingredients, ...ingredients],
        instructions: [...kotlet.instructions, line],
      });
      const numberErrors = (recipe: WriterRecipe, body: string) => {
        const content = clone(example.content);
        step(content, 's12').body = body;
        return qualityChecks(recipe, content).errors.filter((e) =>
          e.includes('liczba'),
        );
      };

      it.each([
        // [składnik, krok przepisu, tekst scenariusza]
        [
          { ingredientId: 'jaj', name: 'jajko', amount: 2, unit: 'szt' },
          'Na patelni usmaż 2 jajka sadzone.',
          'Usmaż 2 jajka sadzone.',
        ],
        [
          { ingredientId: 'bia', name: 'białko jaja', amount: 3, unit: 'szt' },
          'Oddziel 3 białka od żółtek.',
          'Oddziel 3 białka.',
        ],
        [
          {
            ingredientId: 'oli',
            name: 'oliwa z oliwek',
            amount: 40,
            unit: 'ml',
          },
          'Skrop 2 łyżkami oliwy.',
          'Skrop 2 łyżkami oliwy.',
        ],
        [
          {
            ingredientId: 'mlk',
            name: 'mleko kokosowe z puszki',
            amount: 150,
            unit: 'ml',
          },
          'Wymieszaj z mlekiem kokosowym, 150 ml wody i cynamonem.',
          'Wymieszaj ze 150 ml wody i mleka kokosowego.',
        ],
        [
          {
            ingredientId: 'mlk',
            name: 'mleko kokosowe z puszki',
            amount: 150,
            unit: 'ml',
          },
          'Wymieszaj z mlekiem kokosowym, 150 ml wody i cynamonem.',
          'Wlej 150 ml wody lub mleka kokosowego.',
        ],
        [
          {
            ingredientId: 'ole',
            name: 'olej rzepakowy',
            amount: 60,
            unit: 'ml',
          },
          'Polej 2 łyżkami oleju (30 ml).',
          'Dodaj olej (30 ml).',
        ],
      ])('ilość składnika %#: „%s” — błąd', (ingredient, line, body) => {
        expect(numberErrors(withRecipe([ingredient], line), body)).toHaveLength(
          1,
        );
      });

      it.each([
        // [krok przepisu, tekst scenariusza]
        ['Dolej 150 ml wody i wymieszaj.', 'Dolej wody – ok. 150 ml.'],
        ['Zalej kaszę 200 ml wrzątku.', 'Zalej kaszę 200 ml gorącej wody.'],
        [
          'Naczynie o pojemności ok. 1,5 l wysmaruj masłem.',
          'Przygotuj naczynie żaroodporne ok. 1,5 l.',
        ],
        [
          'Naczynie o pojemności ok. 1,5 l wysmaruj masłem.',
          'Naczynie (ok. 1,5 l) wysmaruj masłem.',
        ],
        [
          'Masę rozlej do 8 foremek na lody (po około 100 ml).',
          'Masę rozlej do foremek na lody (po około 100 ml).',
        ],
        [
          'Dodaj 2–3 łyżki wody z makaronu.',
          'Dodaj 2–3 łyżki wody z makaronu.',
        ],
      ])('dosłowna ilość spoza listy: „%s” → „%s” — wolno', (line, body) => {
        expect(numberErrors(withRecipe([], line), body)).toEqual([]);
      });

      it.each([
        // Fala 1 — prawdziwe przepisy (sól w szczyptach, polecenie po przecinku).
        [
          'Wlej bulion warzywny i 350 ml wody, dopraw solą i pieprzem, przykryj garnek.',
          'Wlej bulion i 350 ml wody, dopraw połową soli i pieprzu.',
        ],
        [
          'Zmiksuj mąkę, mleko, jajka, 5 ml oleju, sól i 50 ml wody na gładkie ciasto.',
          'Do kielicha blendera wlej mleko i 50 ml wody, wbij jajka, dodaj mąkę, sól i część oleju.',
        ],
      ])(
        'fala 1: „%s” → „%s” — woda, nie sól (szczypta) ani mleko',
        (line, body) => {
          const recipe = withRecipe(
            [
              {
                ingredientId: 'sol-s',
                name: 'sól morska',
                amount: 1,
                unit: 'szczypta',
              },
              {
                ingredientId: 'bul',
                name: 'bulion warzywny',
                amount: 350,
                unit: 'ml',
              },
              { ingredientId: 'mle', name: 'mleko', amount: 250, unit: 'ml' },
            ],
            line,
          );
          expect(numberErrors(recipe, body)).toEqual([]);
        },
      );

      it('„Odmierz 50 ml, wlej olej” — bez rzeczy przed przecinkiem to ilość oleju (review Codexa, #265)', () => {
        const recipe = withRecipe(
          [
            {
              ingredientId: 'ole2',
              name: 'olej słonecznikowy',
              amount: 50,
              unit: 'ml',
            },
          ],
          'Do miarki odmierz 50 ml, wlej olej na patelnię.',
        );
        expect(
          numberErrors(
            recipe,
            'Do miarki odmierz 50 ml, wlej olej na patelnię.',
          ),
        ).toHaveLength(1);
        // Rzecz tuż przy liczbie — bez względu na wymiar (sól w szczyptach).
        const salty = withRecipe(
          [
            {
              ingredientId: 'sol-m',
              name: 'sól morska',
              amount: 1,
              unit: 'szczypta',
            },
          ],
          'Dolej 50 ml wody i 50 g mąki ziemniaczanej rozrobionej w wodzie.',
        );
        expect(numberErrors(salty, 'Dodaj 50 ml soli.')).toHaveLength(1);
        expect(numberErrors(salty, 'Dodaj 50 g soli.')).toHaveLength(1);
        expect(
          numberErrors(salty, 'Dodaj 50 ml drobno mielonej soli.'),
        ).toHaveLength(1);
        expect(numberErrors(salty, 'Dolej 50 ml wody.')).toEqual([]);
        // Nawias z określnikiem — dalej ilość rzeczy przed nawiasem.
        const oily = withRecipe(
          [
            {
              ingredientId: 'ole3',
              name: 'olej rzepakowy',
              amount: 30,
              unit: 'ml',
            },
          ],
          'Wlej olej (ok. 30 ml) na patelnię.',
        );
        expect(numberErrors(oily, 'Wlej olej (ok. 30 ml).')).toHaveLength(1);
        expect(numberErrors(oily, 'Wlej olej (około 30 ml).')).toHaveLength(1);
        const oily2 = withRecipe(
          [
            {
              ingredientId: 'ole4',
              name: 'olej rzepakowy',
              amount: 30,
              unit: 'ml',
            },
          ],
          'Wlej olej (po około 30 ml) do każdej foremki.',
        );
        expect(
          numberErrors(oily2, 'Wlej olej (po około 30 ml) do każdej foremki.'),
        ).toHaveLength(1);
        // Okolicznik po jednostce to nie odmierzana rzecz (review Codexa #265).
        expect(
          numberErrors(
            recipe,
            'Odmierz 50 ml czystą miarką, wlej olej na patelnię.',
          ),
        ).toHaveLength(1);
        expect(
          numberErrors(
            recipe,
            'Odmierz 50 ml do miarki, wlej olej na patelnię.',
          ),
        ).toHaveLength(1);
      });

      it('tury: „wsyp pierogi partiami” to tury, „podawaj porcjami” i „wlewaj po chochli” — nie; „w dwóch turach” = dwa timery', () => {
        const turns = (line: string) =>
          [...recipeDurationPool([line]).extraTurns].length;
        expect(
          turns('Wsyp pierogi partiami do wrzątku i gotuj 4 minuty.'),
        ).toBe(2);
        expect(turns('Podawaj porcjami, odstaw na 10 minut.')).toBe(0);
        expect(
          turns('Bulion wlewaj po chochli, mieszając, przez 20 minut.'),
        ).toBe(0);
        expect(turns('Piecz w dwóch turach po 12 minut.')).toBe(1);
      });
    });

    it('totalMinutes nie krótszy niż odliczania po kolei', () => {
      // Masło 15 min, potem kotlety 10 i piekarnik 5 — ziemniaki w tle.
      expect(timelineFloorSeconds(example.content)).toBe(1800);
      const content = clone(example.content);
      content.totalMinutes = 20;
      expect(qualityChecks(kotlet, content).errors).toContainEqual(
        expect.stringContaining(
          'totalMinutes 20: same odliczania trwają co najmniej 30 min',
        ),
      );
    });

    it('token {count:…} tylko w body, forma do 20 znaków, długość po najdłuższej formie', () => {
      const content = clone(example.content);
      step(content, 's2').title =
        'Rozbij {count:cutlets|kotlet|kotlety|kotletów}';
      step(content, 's1').body =
        `${step(content, 's1').body} Uformuj {count:rolls|wałeczek|wałeczki|wałeczkówwałeczkówwał}.`;
      const errors = qualityChecks(kotlet, content).errors;
      expect(errors).toContainEqual(
        expect.stringContaining(
          's2.title: token {count:…} wolno tylko w treści kroku',
        ),
      );
      expect(errors).toContainEqual(
        expect.stringMatching(/s1\.body: forma w tokenie .* ma 21 znaków/),
      );
      expect(shownLength('{count:x|a|bb|ccc} z')).toBe(9);
    });

    it('„Włącz piekarnik na 180°C” też nagrzewa; krok nagrzewania mówiący „w piekarniku” to nie użycie', () => {
      const content = clone(example.content);
      step(content, 's5').title = 'Włącz piekarnik na 180°C';
      step(content, 's5').body =
        'Ustaw w piekarniku grzanie góra–dół, bez termoobiegu.';
      expect(
        qualityChecks(kotlet, content).errors.filter((e) =>
          e.includes('piekarnik'),
        ),
      ).toEqual([]);
    });

    it('„100 ml wody, a potem mleko” — woda spoza listy nie jest ilością mleka; „100 ml mleka” jest', () => {
      const recipe: WriterRecipe = {
        ...kotlet,
        ingredients: [
          ...kotlet.ingredients,
          { ingredientId: 'mleko', name: 'mleko', amount: 200, unit: 'ml' },
        ],
        instructions: [
          ...kotlet.instructions,
          'Zagotuj 100 ml wody, a potem wlej mleko.',
        ],
      };
      const content = clone(example.content);
      const s12 = step(content, 's12');
      s12.body = 'Zagotuj 100 ml wody, a potem wlej mleko.';
      const numberErrors = () =>
        qualityChecks(recipe, content).errors.filter((e) =>
          e.includes('liczba „100”'),
        );
      expect(numberErrors()).toEqual([]);
      s12.body = 'Wlej 100 ml mleka.';
      expect(numberErrors()).toHaveLength(1);
    });

    it('owoce morza mają własny sygnał („różowe i jędrne”), nie rybi', () => {
      const recipe: WriterRecipe = {
        ...kotlet,
        ingredients: kotlet.ingredients.map((row) =>
          row.name === 'filet z kurczaka'
            ? {
                ...row,
                ingredientId: 'krewetki',
                name: 'krewetki',
                department: 'Ryby',
              }
            : row,
        ),
      };
      const content = clone(example.content);
      for (const st of content.steps) {
        for (const item of st.ingredients) {
          if (item.ingredientId === 'filet z kurczaka')
            item.ingredientId = 'krewetki';
        }
        st.mentions = st.mentions.map((id) =>
          id === 'filet z kurczaka' ? 'krewetki' : id,
        );
      }
      const oven = content.steps.find((st) => st.timer?.id === 't-oven')!;
      oven.note = { kind: 'CUE', text: 'Krewetki są różowe i jędrne.' };
      const safety = () =>
        qualityChecks(recipe, content).errors.filter((e) =>
          e.startsWith('bezpieczeństwo'),
        );
      expect(safety()).toEqual([]);
      oven.note = { kind: 'CUE', text: 'Panierka jest złota.' };
      expect(safety()).toEqual([
        expect.stringContaining('owoce morza: „krewetki”'),
      ]);
    });

    it('sygnał „po czym poznać” w kroku przygotowania nie wystarcza — ma stać w kroku obróbki', () => {
      const content = clone(example.content);
      content.steps.find((st) => st.timer?.id === 't-oven')!.note = null;
      step(content, 's2').note = {
        kind: 'CUE',
        text: 'Po upieczeniu w środku ma być 74°C.',
      };
      expect(qualityChecks(kotlet, content).errors).toContainEqual(
        expect.stringContaining(
          'stoi w kroku przygotowania — przenieś je do kroku obróbki',
        ),
      );
    });

    it('litery innych alfabetów udające łacinę = błąd (cyrylica z próby .5)', () => {
      const content = clone(example.content);
      step(content, 's11').body = 'Postaw garnek na chwilę w ciепle.';
      expect(qualityChecks(kotlet, content).errors).toContainEqual(
        expect.stringContaining('s11.body: znak „е” spoza polskiego alfabetu'),
      );
    });

    it('dwa odliczania naraz: nazwa-czynność albo ta sama nazwa = błąd; pojedynczo nazwa-czynność wolno', () => {
      const labelErrors = (mutate: (content: Content) => void) => {
        const content = clone(example.content);
        mutate(content);
        return qualityChecks(kotlet, content).errors.filter((e) =>
          /biegnie razem/.test(e),
        );
      };
      // Masło chłodzi się, gdy gotują się ziemniaki.
      expect(
        labelErrors((c) => {
          step(c, 's1').timer!.label = 'Chłodzenie';
        }),
      ).toEqual([expect.stringContaining('„Chłodzenie” biegnie razem')]);
      expect(
        labelErrors((c) => {
          step(c, 's3').timer!.label = 'Masło';
        }),
      ).toEqual([
        expect.stringContaining('biegnie razem z timerem o tej samej nazwie'),
      ]);
      // Piekarnik rusza, gdy ziemniaki już się ugotowały — sam.
      expect(
        labelErrors((c) => {
          c.steps.find((st) => st.timer?.id === 't-oven')!.timer!.label =
            'Pieczenie';
        }),
      ).toEqual([]);
    });

    it('forma zależna od płci („jeśli nie obracałeś”) — ostrzeżenie; „właśnie”, „zbyt” — nie', () => {
      const content = clone(example.content);
      step(content, 's8').timer!.alert.title = 'Obróć, jeśli nie obracałeś';
      step(content, 's11').body =
        'Postaw garnek, właśnie tak, żeby odparowały.';
      const warnings = qualityChecks(kotlet, content).warnings.filter((w) =>
        w.includes('płci'),
      );
      expect(warnings).toEqual([
        expect.stringContaining(
          's8.timer.alert.title: forma zależna od płci („obracałeś”)',
        ),
      ]);
    });

    it('EVENT bez „Gdy…” i NOW z „Gdy…” — ostrzeżenia dla recenzenta', () => {
      const content = clone(example.content);
      step(content, 's3').timer!.startLabel = 'Garnek na ogniu';
      step(content, 's1').timer!.startLabel = 'Gdy masło stwardnieje';
      const warnings = qualityChecks(kotlet, content).warnings;
      expect(warnings).toContainEqual(
        expect.stringContaining('s3.timer: trigger EVENT'),
      );
      expect(warnings).toContainEqual(expect.stringContaining('a trigger NOW'));
    });

    it('SKIP: krótki czas aktywnej czynności („miksuj 30–40 s”) go nie blokuje', () => {
      expect(
        skipGuard({
          ...kotlet,
          title: 'Koktajl bananowy',
          instructions: ['Zmiksuj wszystkie składniki na gładko 30–40 sekund.'],
          equipment: ['BLENDER'],
          prepTimeMinutes: 5,
        }),
      ).toBeNull();
    });

    it('błąd kształtu podaje id kroku i cytuje napis do skrócenia (próba .5: schab trzy razy)', () => {
      const bad = output() as unknown as {
        scenario: { steps: Array<{ timer: { label: string } | null }> };
      };
      bad.scenario.steps[8].timer!.label = 'Kotlety na złoto';
      expect(resolveWriterOutput(kotlet, bad).errors).toContainEqual(
        expect.stringContaining(
          's9.timer.label „Kotlety na złoto”: 16 znaków, limit 14',
        ),
      );
    });
  });
});
