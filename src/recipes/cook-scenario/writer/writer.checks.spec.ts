import {
  qualityChecks,
  recipeDurations,
  resolveWriterOutput,
  skipGuard,
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
      'steps[0].ingredients[0]: klucza „i99” nie ma w przepisie',
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
      expect.stringContaining(`${step.id}.title: 31 znaków, limit 30`),
    );
    // 240 liter + spacja + token (~10 znaków na ekranie) = 251 → mieści się.
    expect(errors.filter((e) => e.startsWith(`${step.id}.body:`))).toEqual([]);
    expect(errors).toContainEqual(
      expect.stringContaining(
        `${step.id}.timer.startLabel: 24 znaków, limit 20`,
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
        w.startsWith('s10:'),
      ),
    ).toEqual([]);
    s10.body = 'Pokrój ogórek, dodaj śmietanę i pieprz — serwuj od razu.';
    expect(qualityChecks(kotlet, content).warnings).toContainEqual(
      expect.stringContaining('s10: składnik „sól”'),
    );
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
        (st) => !st.timer && !st.during && /smaż|patel/i.test(st.body),
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

    it('odliczania po kolei pod jednym timerem: zapas 2 min przechodzi, więcej nie', () => {
      const content = clone(example.content);
      // Pod masłem (15 min): 14 min, potem ziemniaki (ostatnie, mogą biec dalej).
      const s2 = content.steps.find((s) => s.id === 's2')!;
      s2.timer = {
        ...content.steps[0].timer!,
        id: 't-a',
        minSeconds: 840,
        maxSeconds: 840,
      };
      const withRecipe = {
        ...kotlet,
        instructions: [
          ...kotlet.instructions,
          'Odstaw na 14 minut.',
          'Odstaw na 19 minut.',
        ],
      };
      expect(
        qualityChecks(withRecipe, content).errors.filter((e) =>
          e.includes('nie zmieszczą'),
        ),
      ).toEqual([]);
      s2.timer = { ...s2.timer, minSeconds: 1140, maxSeconds: 1140 };
      expect(
        qualityChecks(withRecipe, content).errors.filter((e) =>
          e.includes('nie zmieszczą'),
        ),
      ).toHaveLength(1);
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
});
