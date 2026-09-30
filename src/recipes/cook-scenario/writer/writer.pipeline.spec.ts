import { clone, kotletExample } from './writer.fixtures.spec-helper';
import { DEFAULT_WRITER_OPTIONS, writeCookScenario } from './writer.pipeline';
import { exampleOutput } from './writer.prompt';
import type {
  WriterModel,
  WriterModelCall,
  WriterModelResult,
  WriterRecipe,
} from './writer.types';

const example = kotletExample();
const kotlet = example.recipe;
const good = () => clone(exampleOutput(kotlet, example.content));

const usage = (costMicroUsd: number) => ({
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costMicroUsd,
  priceKnown: true,
});

/** Model z kolejką odpowiedzi; zapisuje wywołania do asercji. */
class StubModel implements WriterModel {
  readonly calls: WriterModelCall[] = [];
  constructor(private readonly replies: Array<unknown>) {}
  complete(call: WriterModelCall): Promise<WriterModelResult> {
    this.calls.push(call);
    if (!this.replies.length) throw new Error('stub: brak odpowiedzi');
    const json = this.replies.shift();
    return Promise.resolve({
      json,
      stopReason: 'end_turn',
      usage: usage(1000),
    });
  }
}

const review = (score: number, issues: unknown[] = []) => ({
  score,
  issues,
  summary: `ocena ${score}`,
});

const badKey = () => {
  const out = good() as {
    scenario: { steps: Array<{ ingredients: Array<{ key: string }> }> };
  };
  out.scenario.steps[0].ingredients[0].key = 'i99';
  return out;
};

describe('system pisania — przebieg', () => {
  it('dobra treść i ocena 5 = VALIDATED po dwóch wywołaniach (autor, recenzent)', async () => {
    const model = new StubModel([good(), review(5)]);
    const outcome = await writeCookScenario(model, kotlet, example);
    expect(outcome.status).toBe('VALIDATED');
    expect(outcome.content).toEqual(example.content);
    expect(outcome.review?.score).toBe(5);
    expect(model.calls.map((call) => call.model)).toEqual([
      DEFAULT_WRITER_OPTIONS.writerModel,
      DEFAULT_WRITER_OPTIONS.reviewerModel,
    ]);
    expect(outcome.usage.costMicroUsd).toBe(2000);
  });

  it('błąd walidatora wraca do autora w raporcie, poprawiona wersja przechodzi', async () => {
    const model = new StubModel([badKey(), good(), review(4)]);
    const outcome = await writeCookScenario(model, kotlet, example);
    expect(outcome.status).toBe('VALIDATED');
    expect(outcome.attempts).toHaveLength(2);
    expect(outcome.attempts[0].errors).toEqual([
      'steps[0].ingredients[0]: klucza „i99” nie ma w przepisie',
    ]);
    expect(model.calls[1].user).toContain(
      'POPRZEDNIA WERSJA NIE PRZESZŁA KONTROLI',
    );
    expect(model.calls[1].user).toContain('klucza „i99”');
    // Stała część promptu ta sama przy każdej próbie — cache działa.
    expect(model.calls[1].system).toBe(model.calls[0].system);
  });

  it('niska ocena recenzenta = poprawka z jego uwagami (bez MINOR)', async () => {
    const model = new StubModel([
      good(),
      review(3, [
        { stepId: 's6', severity: 'MAJOR', text: 'niejasne zawijanie' },
        { stepId: null, severity: 'MINOR', text: 'przecinek' },
      ]),
      good(),
      review(4),
    ]);
    const outcome = await writeCookScenario(model, kotlet, example);
    expect(outcome.status).toBe('VALIDATED');
    expect(model.calls[2].user).toContain('[s6] MAJOR: niejasne zawijanie');
    expect(model.calls[2].user).not.toContain('przecinek');
  });

  it('BLOCKER odrzuca nawet przy ocenie 5; po wyczerpaniu prób REJECTED z ostatnią treścią', async () => {
    const blocker = review(5, [
      { stepId: 's2', severity: 'BLOCKER', text: 'składnik spoza przepisu' },
    ]);
    const model = new StubModel([
      good(),
      blocker,
      good(),
      blocker,
      good(),
      blocker,
    ]);
    const outcome = await writeCookScenario(model, kotlet, example);
    expect(outcome.status).toBe('REJECTED');
    expect(outcome.attempts).toHaveLength(3);
    expect(outcome.content).toEqual(example.content);
    expect(outcome.review?.issues[0].severity).toBe('BLOCKER');
  });

  it('same błędy walidatorów = REJECTED bez treści i bez recenzenta', async () => {
    const model = new StubModel([badKey(), badKey(), badKey()]);
    const outcome = await writeCookScenario(model, kotlet, example);
    expect(outcome).toMatchObject({
      status: 'REJECTED',
      content: null,
      review: null,
    });
    expect(model.calls).toHaveLength(3);
  });

  it('SKIP przepisu z czasami jest zablokowany i autor pisze od nowa', async () => {
    const model = new StubModel([
      { decision: 'SKIP', skipReason: 'proste', scenario: null },
      good(),
      review(5),
    ]);
    const outcome = await writeCookScenario(model, kotlet, example);
    expect(outcome.status).toBe('VALIDATED');
    expect(outcome.attempts[0].errors[0]).toContain('SKIP niedozwolony');
  });

  it('SKIP przepisu trywialnego = SKIPPED z powodem, bez recenzenta', async () => {
    const yogurt: WriterRecipe = {
      ...kotlet,
      title: 'Jogurt z granolą',
      equipment: [],
      prepTimeMinutes: 5,
      instructions: ['Jogurt przełóż do miseczki.', 'Posyp granolą i owocami.'],
    };
    const model = new StubModel([
      {
        decision: 'SKIP',
        skipReason: 'Samo złożenie gotowych składników.',
        scenario: null,
      },
    ]);
    const outcome = await writeCookScenario(model, yogurt, example);
    expect(outcome).toMatchObject({
      status: 'SKIPPED',
      skipReason: 'Samo złożenie gotowych składników.',
      content: null,
    });
    expect(model.calls).toHaveLength(1);
  });

  it('zepsuta odpowiedź recenzenta = REJECTED bez przepisywania w kółko', async () => {
    const model = new StubModel([good(), { score: 9 }]);
    const outcome = await writeCookScenario(model, kotlet, example);
    expect(outcome.status).toBe('REJECTED');
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.attempts[0].errors).toEqual([
      'recenzent: odpowiedź niezgodna ze schematem',
    ]);
    expect(model.calls).toHaveLength(2);
  });

  it('ucięta odpowiedź (max_tokens) wraca do autora jako błąd', async () => {
    const model = new StubModel([good(), good(), review(5)]);
    const original = model.complete.bind(model);
    let first = true;
    model.complete = async (call) => {
      const result = await original(call);
      if (first) {
        first = false;
        return { ...result, stopReason: 'max_tokens' };
      }
      return result;
    };
    const outcome = await writeCookScenario(model, kotlet, example);
    expect(outcome.status).toBe('VALIDATED');
    expect(outcome.attempts[0].errors[0]).toContain('odpowiedź ucięta');
  });
});
