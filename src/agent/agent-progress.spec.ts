import {
  appendProgress,
  AgentProgressStep,
  PROGRESS_FALLBACK,
  progressStep,
} from './agent-progress';

describe('progressStep', () => {
  it('tłumaczy nazwę narzędzia na zdanie dla człowieka', () => {
    const step = progressStep('get_week_balance');
    expect(step.tool).toBe('get_week_balance');
    expect(step.label).toBe('Liczę bilans dnia');
    expect(step.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('odróżnia próbę od zapisu — użytkownik musi wiedzieć, co się dzieje z jego tygodniem', () => {
    expect(progressStep('apply_week_plan', {}).label).toBe(
      'Zapisuję plan tygodnia',
    );
    expect(progressStep('apply_week_plan', { dry_run: true }).label).toBe(
      'Sprawdzam, czy plan się spina',
    );
  });

  it('nowe narzędzie bez etykiety nie zostawia pustki', () => {
    expect(progressStep('zupelnie_nowe').label).toBe(PROGRESS_FALLBACK);
  });
});

describe('appendProgress', () => {
  const steps: AgentProgressStep[] = [];

  it('dokłada pierwszy krok', () => {
    expect(appendProgress(steps, progressStep('search_ingredients'))).toBe(
      true,
    );
    expect(steps).toHaveLength(1);
  });

  it('powtórzone to samo narzędzie NIE jest postępem, tylko szumem', () => {
    // Model potrafi wywołać wyszukiwarkę osiem razy pod rząd.
    expect(appendProgress(steps, progressStep('search_ingredients'))).toBe(
      false,
    );
    expect(steps).toHaveLength(1);
  });

  it('zmiana narzędzia jest postępem', () => {
    expect(appendProgress(steps, progressStep('apply_week_plan'))).toBe(true);
    expect(steps).toHaveLength(2);
  });

  it('ta sama nazwa z inną etykietą też jest postępem', () => {
    // `apply_week_plan` z `dry_run` i bez to dwa różne zdarzenia dla użytkownika.
    expect(
      appendProgress(steps, progressStep('apply_week_plan', { dry_run: true })),
    ).toBe(true);
    expect(steps).toHaveLength(3);
  });
});
