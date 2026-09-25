import {
  answeringModel,
  reportReasonOf,
  reportStatusOf,
  reportTurnStatusOf,
} from './report-view';

describe('widok zgłoszenia', () => {
  it('model, który napisał odpowiedź: po przekazaniu pałeczki — planista', () => {
    // CHAT na Haiku (model startowy tury) → PLANNER na Sonnecie.
    expect(
      answeringModel('claude-haiku-4-5', [
        { model: 'claude-haiku-4-5', costMicroUsd: 10_000 },
        { model: 'claude-sonnet-5', costMicroUsd: 50_000 },
      ]),
    ).toBe('claude-sonnet-5');
    // Nawet gdy faza planisty była tańsza — rozstrzyga trasa, nie koszt.
    expect(
      answeringModel('claude-haiku-4-5', [
        { model: 'claude-haiku-4-5', costMicroUsd: 90_000 },
        { model: 'claude-sonnet-5', costMicroUsd: 5_000 },
      ]),
    ).toBe('claude-sonnet-5');
  });

  it('jedna faza — model startowy; bez modelu startowego — najdroższa faza', () => {
    expect(
      answeringModel('claude-sonnet-5', [
        { model: 'claude-sonnet-5', costMicroUsd: 1 },
      ]),
    ).toBe('claude-sonnet-5');
    expect(answeringModel('claude-sonnet-5', [])).toBe('claude-sonnet-5');
    expect(
      answeringModel(null, [
        { model: 'a', costMicroUsd: 10 },
        { model: 'b', costMicroUsd: 30 },
      ]),
    ).toBe('b');
    expect(answeringModel(null, [])).toBe('');
  });

  it('statusy spoza kontraktu nie znikają z kolejki', () => {
    expect(reportStatusOf('REVIEWED')).toBe('REVIEWED');
    expect(reportStatusOf('DISMISSED')).toBe('DISMISSED');
    expect(reportStatusOf('ACTIONED')).toBe('NEW');
  });

  it('powód spoza listy iOS to OTHER', () => {
    expect(reportReasonOf('UNSAFE')).toBe('UNSAFE');
    expect(reportReasonOf('SPAM')).toBe('OTHER');
  });

  it('tura: DONE albo nieudana (LIMITED i niedomknięta też)', () => {
    expect(reportTurnStatusOf('DONE')).toBe('DONE');
    expect(reportTurnStatusOf('FAILED')).toBe('FAILED');
    expect(reportTurnStatusOf('LIMITED')).toBe('FAILED');
    expect(reportTurnStatusOf('RUNNING')).toBe('FAILED');
  });
});
