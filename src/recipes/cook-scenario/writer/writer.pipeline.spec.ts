import { clone, kotletExample } from './writer.fixtures.spec-helper';
import {
  DEFAULT_WRITER_OPTIONS,
  ScenarioJob,
  writeCookScenario,
  type RevisionSeed,
} from './writer.pipeline';
import { exampleOutput, REVIEWER_SYSTEM } from './writer.prompt';
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
      's1.ingredients[0]: klucza „i99” nie ma w przepisie',
    ]);
    expect(model.calls[1].user).toContain('NIE PRZESZŁA KONTROLI');
    expect(model.calls[1].user).toContain('klucza „i99”');
    // Stała część promptu ta sama przy każdej próbie — cache działa.
    expect(model.calls[1].system).toBe(model.calls[0].system);
  });

  it('poprawka dostaje poprzednią wersję, a recenzent swoje wcześniejsze uwagi', async () => {
    const model = new StubModel([
      badKey(),
      good(),
      review(3, [
        { stepId: 's6', severity: 'MAJOR', text: 'niejasne zawijanie' },
      ]),
      good(),
      review(4),
    ]);
    const outcome = await writeCookScenario(model, kotlet, example);
    expect(outcome.status).toBe('VALIDATED');
    // Próba 2: poprawka poprzedniej wersji (z kluczem i99), nie pisanie od zera.
    expect(model.calls[1].user).toContain('TWOJA POPRZEDNIA WERSJA');
    expect(model.calls[1].user).toContain('"key":"i99"');
    // Pierwsza recenzja bez historii, druga z uwagami do poprzedniej wersji.
    expect(model.calls[2].user).not.toContain('TWOJE UWAGI');
    expect(model.calls[4].user).toContain('TWOJE UWAGI DO POPRZEDNIEJ WERSJI');
    expect(model.calls[4].user).toContain('[s6] MAJOR: niejasne zawijanie');
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

  it('MAJOR też odrzuca przy ocenie 4 i 5 — o przejściu decyduje kod, nie ocena', async () => {
    const major = (score: number) =>
      review(score, [{ stepId: 's6', severity: 'MAJOR', text: 'niejasne' }]);
    const model = new StubModel([
      good(),
      major(5),
      good(),
      major(4),
      good(),
      review(4),
    ]);
    const outcome = await writeCookScenario(model, kotlet, example);
    expect(outcome.status).toBe('VALIDATED');
    expect(outcome.attempts).toHaveLength(3);
    expect(outcome.attempts.map((a) => a.review?.score)).toEqual([5, 4, 4]);
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

  it('zepsuta odpowiedź recenzenta: ponawiamy SAMĄ recenzję, autor nie pisze od nowa', async () => {
    const model = new StubModel([good(), { score: 9 }, review(5)]);
    const outcome = await writeCookScenario(model, kotlet, example);
    expect(outcome.status).toBe('VALIDATED');
    expect(outcome.attempts).toHaveLength(1);
    expect(model.calls.map((call) => call.model)).toEqual([
      DEFAULT_WRITER_OPTIONS.writerModel,
      DEFAULT_WRITER_OPTIONS.reviewerModel,
      DEFAULT_WRITER_OPTIONS.reviewerModel,
    ]);
    expect(outcome.attempts[0].warnings).toContainEqual(
      expect.stringContaining('ponawiam recenzję'),
    );
  });

  it('recenzja zepsuta za każdym razem = REJECTED po jednym ponowieniu, bez przepisywania w kółko', async () => {
    const model = new StubModel([good(), { score: 9 }, {}]);
    const outcome = await writeCookScenario(model, kotlet, example);
    expect(outcome.status).toBe('REJECTED');
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.attempts[0].errors).toEqual([
      'recenzent: odpowiedź niezgodna ze schematem',
    ]);
    expect(model.calls).toHaveLength(3);
  });

  it('niespójna recenzja (1/5 bez uwag) to recenzja do powtórki, nie VALIDATED ani wersja w odwodzie', async () => {
    const model = new StubModel([good(), review(1), review(1)]);
    const outcome = await writeCookScenario(model, kotlet, example);
    expect(outcome.status).toBe('REJECTED');
    expect(outcome.attempts[0].errors[0]).toContain('niespójna');
    expect(model.calls).toHaveLength(3);
  });

  it('w odwodzie zostaje NAJLEPSZA wersja 3/5 z MINOR, oznaczona jako poniżej progu', async () => {
    const minor = (text: string) => [{ stepId: 's7', severity: 'MINOR', text }];
    const worse = good() as { scenario: { tips: string[] } };
    worse.scenario.tips = ['Inna rada.'];
    const model = new StubModel([
      good(),
      review(3, minor('A')),
      worse,
      review(3, minor('B')),
      badKey(),
    ]);
    const outcome = await writeCookScenario(model, kotlet, example);
    expect(outcome.status).toBe('VALIDATED');
    expect(outcome.belowThreshold).toBe(true);
    // Remis ocen — zostaje nowsza (po poprawce).
    expect(outcome.content?.tips).toEqual(['Inna rada.']);
  });

  it('ponowienie po uciętej recenzji dostaje wyższy limit tokenów', async () => {
    const model = new StubModel([good(), review(5), review(5)]);
    const original = model.complete.bind(model);
    let reviews = 0;
    model.complete = async (call) => {
      const result = await original(call);
      if (call.system === REVIEWER_SYSTEM && !reviews++) {
        return { ...result, stopReason: 'max_tokens' };
      }
      return result;
    };
    await writeCookScenario(model, kotlet, example);
    const reviewerCalls = model.calls.filter(
      (call) => call.system === REVIEWER_SYSTEM,
    );
    expect(reviewerCalls[1].maxTokens).toBeGreaterThan(
      reviewerCalls[0].maxTokens,
    );
  });

  it('ucięta recenzja (max_tokens) też idzie jeszcze raz — to nie wina autora', async () => {
    const model = new StubModel([good(), review(5), review(5)]);
    const original = model.complete.bind(model);
    let reviews = 0;
    model.complete = async (call) => {
      const result = await original(call);
      // Autor i recenzent to ten sam model — recenzenta poznajemy po prompcie.
      if (call.system === REVIEWER_SYSTEM && !reviews++) {
        return { ...result, stopReason: 'max_tokens' };
      }
      return result;
    };
    const outcome = await writeCookScenario(model, kotlet, example);
    expect(outcome.status).toBe('VALIDATED');
    expect(outcome.attempts).toHaveLength(1);
  });

  it('ocena poniżej progu bez BLOCKER/MAJOR: autor dostaje MINOR; gdy dalej nic nie blokuje — VALIDATED, nie REJECTED', async () => {
    const minor = [
      { stepId: 's7', severity: 'MINOR', text: 'Alarm powtarza adnotację.' },
    ];
    const model = new StubModel([
      good(),
      review(3, minor),
      good(),
      review(3, minor),
      good(),
      review(3, minor),
    ]);
    const outcome = await writeCookScenario(model, kotlet, example);
    // Bez tej poprawki autor dostawał samą ocenę, bez żadnej uwagi.
    expect(model.calls[2].user).toContain('Alarm powtarza adnotację.');
    expect(outcome.status).toBe('VALIDATED');
    expect(outcome.review?.score).toBe(3);
    expect(outcome.belowThreshold).toBe(true);
    expect(outcome.attempts).toHaveLength(3);
  });

  it('wersja bez BLOCKER/MAJOR zostaje w odwodzie, gdy dalsza poprawka padnie na walidatorach', async () => {
    const minor = [{ stepId: 's7', severity: 'MINOR', text: 'Skróć treść.' }];
    const model = new StubModel([good(), review(3, minor), badKey(), badKey()]);
    const outcome = await writeCookScenario(model, kotlet, example);
    expect(outcome.status).toBe('VALIDATED');
    expect(outcome.content).toEqual(example.content);
    expect(outcome.review?.score).toBe(3);
  });

  it('MAJOR do końca = REJECTED (wersji w odwodzie nie ma)', async () => {
    const major = [
      { stepId: 's7', severity: 'MAJOR', text: 'Nie wiadomo, kiedy wyjąć.' },
    ];
    const model = new StubModel([
      good(),
      review(3, major),
      good(),
      review(3, major),
      good(),
      review(3, major),
    ]);
    const outcome = await writeCookScenario(model, kotlet, example);
    expect(outcome.status).toBe('REJECTED');
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
    // Druga próba autora z wyższym limitem (długie przepisy, próba w7).
    expect(model.calls[1].maxTokens).toBeGreaterThan(model.calls[0].maxTokens);
  });
});

describe('system pisania — poprawka odrzuconej wersji (--revise)', () => {
  const opus = { ...DEFAULT_WRITER_OPTIONS, writerModel: 'claude-opus-5-5' };
  const run = async (model: StubModel, seed: RevisionSeed) => {
    const job = new ScenarioJob(kotlet, example, opus, undefined, seed);
    for (let call = job.nextCall(); call; call = job.nextCall()) {
      job.accept(await model.complete(call));
    }
    return job.outcome();
  };
  const rejected = (): RevisionSeed => ({
    content: clone(example.content),
    review: review(3, [
      { stepId: 's6', severity: 'MAJOR', text: 'ryż skończy się przed mięsem' },
      { stepId: null, severity: 'MINOR', text: 'przecinek' },
    ]),
    errors: [],
  });

  it('pierwsze wywołanie to POPRAWKA: autor dostaje odrzuconą wersję i uwagi recenzenta', async () => {
    const model = new StubModel([good(), review(4)]);
    const outcome = await run(model, rejected());
    expect(outcome.status).toBe('VALIDATED');
    expect(model.calls[0].model).toBe('claude-opus-5-5');
    expect(model.calls[0].user).toContain('TWOJA POPRZEDNIA WERSJA');
    expect(model.calls[0].user).toContain('[s6] MAJOR: ryż skończy się');
    // MAJOR jest — MINOR to szum, jak przy zwykłej poprawce.
    expect(model.calls[0].user).not.toContain('przecinek');
    // Recenzent widzi swoje uwagi do odrzuconej wersji i ich nie wycofa.
    expect(model.calls[1].user).toContain('TWOJE UWAGI DO POPRZEDNIEJ WERSJI');
    // Próby liczą się od nowa: jedna poprawka = jedna próba.
    expect(outcome.attempts).toHaveLength(1);
  });

  it('odrzucenie przez walidatory: autor pisze od nowa z listą błędów', async () => {
    const model = new StubModel([good(), review(5)]);
    const outcome = await run(model, {
      content: null,
      review: null,
      errors: [
        's3.title „Dosmaż łososia z drugiej strony”: 31 znaków, limit 30',
      ],
    });
    expect(outcome.status).toBe('VALIDATED');
    expect(model.calls[0].user).toContain(
      'POPRZEDNIA WERSJA NIE PRZESZŁA KONTROLI',
    );
    expect(model.calls[0].user).not.toContain('TWOJA POPRZEDNIA WERSJA');
    expect(model.calls[0].user).toContain('31 znaków, limit 30');
  });

  it('żadna poprawka nie przeszła walidatorów = REJECTED z odrzuconą treścią i jej recenzją', async () => {
    const model = new StubModel([badKey(), badKey(), badKey()]);
    const seed = rejected();
    const outcome = await run(model, seed);
    expect(outcome.status).toBe('REJECTED');
    expect(outcome.attempts).toHaveLength(3);
    expect(outcome.content).toEqual(seed.content);
    expect(outcome.review).toEqual(seed.review);
  });

  it('treść niepasująca do składników przepisu = wyjątek przy tworzeniu zadania', () => {
    const seed = rejected();
    seed.content!.steps[0].ingredients[0].ingredientId = 'nie-ma-takiego';
    expect(
      () => new ScenarioJob(kotlet, example, opus, undefined, seed),
    ).toThrow(/nie ma w przepisie/);
  });

  it('zadanie poprawki przeżywa dziennik (snapshot → restore) w połowie', async () => {
    const model = new StubModel([good(), review(4)]);
    const job = new ScenarioJob(kotlet, example, opus, undefined, rejected());
    job.accept(await model.complete(job.nextCall()!));
    const restored = ScenarioJob.restore(job.snapshot(), example, opus);
    const call = restored.nextCall()!;
    expect(call.user).toContain('TWOJE UWAGI DO POPRZEDNIEJ WERSJI');
    restored.accept(await model.complete(call));
    expect(restored.outcome().status).toBe('VALIDATED');
  });
});
