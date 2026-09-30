import {
  qualityChecks,
  recipeDurations,
  resolveWriterOutput,
  skipGuard,
} from './writer.checks';
import { clone, kotletExample } from './writer.fixtures.spec-helper';
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

    it('zły token = błąd', () => {
      expect(withBody('Uformuj {ilość} wałeczków.')).toEqual([
        expect.stringContaining('zły token'),
      ]);
    });
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

  it('SKIP dozwolony tylko dla przepisu bez czasów i krótkiego', () => {
    expect(skipGuard(kotlet)).toContain('SKIP niedozwolony');
    expect(
      skipGuard({
        ...kotlet,
        prepTimeMinutes: 5,
        instructions: [
          'Jogurt przełóż do miseczki.',
          'Posyp granolą i owocami.',
        ],
      }),
    ).toBeNull();
  });
});
