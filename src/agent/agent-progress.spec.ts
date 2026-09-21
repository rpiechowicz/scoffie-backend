import {
  appendProgress,
  AgentProgressStep,
  PROGRESS_FALLBACK,
  progressStep,
  THINK_STEP_TOOL,
  READ_STEP_TOOL,
  REASON_STEP_TOOL,
  WRITE_STEP_TOOL,
  settledProgress,
} from './agent-progress';

describe('progressStep', () => {
  it('tłumaczy nazwę narzędzia na zdanie dla człowieka', () => {
    const step = progressStep('get_week_balance');
    expect(step.tool).toBe('get_week_balance');
    // Sformułowań jest kilka, ale każde mówi o liczeniu — nie o narzędziu.
    expect(step.label).toMatch(/Liczę|Sprawdzam|Podliczam/);
    expect(step.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('odróżnia próbę od zapisu — użytkownik musi wiedzieć, co się dzieje z jego tygodniem', () => {
    expect(progressStep('apply_week_plan', {}).label).toMatch(
      /Zapisuję|Wpisuję/,
    );
    expect(progressStep('apply_week_plan', { dry_run: true }).label).toMatch(
      /Sprawdzam|Upewniam/,
    );
  });

  // Ten sam wiersz pod każdym pytaniem czyta się po trzecim razie jak
  // komunikat maszyny. Wybór musi być jednak POWTARZALNY: postęp wraca
  // z każdego odpytania tury i nie może zmieniać się pod ręką.
  it('to samo ziarno daje to samo zdanie, różne ziarna różne', () => {
    const a = progressStep('get_week_plan', {}, new Date(), 'tura-1').label;
    const b = progressStep('get_week_plan', {}, new Date(), 'tura-1').label;
    expect(a).toBe(b);

    const labels = new Set(
      Array.from(
        { length: 12 },
        (_, index) =>
          progressStep('get_week_plan', {}, new Date(), `tura-${index}`).label,
      ),
    );
    expect(labels.size).toBeGreaterThan(1);
  });

  it('każde znane narzędzie ma zdanie, żadne nie wpada w wartość zapasową', () => {
    const tools = [
      'get_household_context',
      'get_week_plan',
      'get_week_balance',
      'search_ingredients',
      'ask_clarifying_question',
      'propose_week_plan',
      'propose_day_plan',
      'propose_swap',
      'propose_household_split',
      'offer_options',
      'show_macro_gap',
      'show_shopping_list',
      'remember_note',
      'apply_week_plan',
      'create_recipe',
      'update_recipe',
      'delete_recipe',
    ];
    for (const tool of tools) {
      expect(progressStep(tool).label).not.toBe(PROGRESS_FALLBACK);
    }
  });

  it('nowe narzędzie bez etykiety nie zostawia pustki', () => {
    expect(progressStep('zupelnie_nowe').label).toBe(PROGRESS_FALLBACK);
    // Nieznane narzędzie nie może udawać, że coś zapisało.
    expect(progressStep('zupelnie_nowe').writes).toBe(false);
  });

  describe('flaga `writes` — czy po turze jest co oglądać', () => {
    it('próba planu NIE zapisuje, zapis planu zapisuje', () => {
      // To jest cały powód istnienia tej flagi: `apply_week_plan` biegnie
      // w każdej turze najpierw jako `dry_run`, więc sama nazwa narzędzia
      // niczego nie dowodzi.
      expect(progressStep('apply_week_plan', { dry_run: true }).writes).toBe(
        false,
      );
      expect(progressStep('apply_week_plan', {}).writes).toBe(true);
    });

    it.each(['create_recipe', 'update_recipe', 'delete_recipe'])(
      '%s zapisuje',
      (tool) => {
        expect(progressStep(tool).writes).toBe(true);
      },
    );

    it.each([
      'get_household_context',
      'get_week_plan',
      'get_week_balance',
      'search_ingredients',
    ])('%s tylko czyta', (tool) => {
      expect(progressStep(tool).writes).toBe(false);
    });
  });
});

describe('krok `think` — cisza między narzędziami', () => {
  it('jest przejściowy i nigdy nie zapisuje', () => {
    // Klient pokazuje go na żywo, ale pomija w podsumowaniu po turze —
    // inaczej co drugi wiersz „Myślałem 42 s" mówiłby to samo zdanie.
    const step = progressStep(THINK_STEP_TOOL, {}, new Date(), 't-1');
    expect(step.transient).toBe(true);
    expect(step.writes).toBe(false);
    expect(step.phase).toBeUndefined();
    expect(step.label).not.toBe(PROGRESS_FALLBACK);
  });

  it('zwykły krok nie dostaje flagi przejściowej', () => {
    // Brak pola = zwykły krok: starszy klient nie ma czego nie rozumieć.
    expect(
      progressStep('get_week_plan', {}, new Date(), 't-1'),
    ).not.toHaveProperty('transient');
  });

  it('przeplata się z narzędziami zamiast się zlewać', () => {
    // narzędzie → think → narzędzie → think: każde kolejne to inna nazwa,
    // więc żadne nie ginie w odsiewie powtórzeń; powtórzone think — tak.
    const steps: AgentProgressStep[] = [];
    const at = new Date();
    expect(
      appendProgress(steps, progressStep('get_week_plan', {}, at, 't')),
    ).toBe(true);
    expect(
      appendProgress(steps, progressStep(THINK_STEP_TOOL, {}, at, 't')),
    ).toBe(true);
    expect(
      appendProgress(steps, progressStep(THINK_STEP_TOOL, {}, at, 't')),
    ).toBe(false);
    expect(
      appendProgress(steps, progressStep('apply_week_plan', {}, at, 't')),
    ).toBe(true);
    expect(steps.map((step) => step.tool)).toEqual([
      'get_week_plan',
      THINK_STEP_TOOL,
      'apply_week_plan',
    ]);
  });
});

describe('kroki `read`, `reason`, `write` — życie tury bez narzędzi', () => {
  it.each([READ_STEP_TOOL, REASON_STEP_TOOL, WRITE_STEP_TOOL])(
    '`%s` jest przejściowy, nie zapisuje i ma polską etykietę',
    (tool) => {
      const step = progressStep(tool, {}, new Date(), 't-1');
      expect(step.transient).toBe(true);
      expect(step.writes).toBe(false);
      expect(step.phase).toBeUndefined();
      expect(step.label).not.toBe(PROGRESS_FALLBACK);
      expect(step.label).not.toContain('_');
    },
  );

  it('settledProgress zostawia po turze tylko to, co asystent zrobił', () => {
    // Na żywo sygnały życia są potrzebne; po turze „Czytam pytanie" i
    // „Piszę odpowiedź" byłyby szumem w „Myślałem 42 s" i w każdym kliencie,
    // który nie zna flagi `transient`.
    const at = new Date();
    const steps = [
      progressStep(READ_STEP_TOOL, {}, at, 't'),
      progressStep(REASON_STEP_TOOL, {}, at, 't'),
      progressStep('get_week_plan', {}, at, 't'),
      progressStep(THINK_STEP_TOOL, {}, at, 't'),
      progressStep('apply_week_plan', {}, at, 't'),
      progressStep(WRITE_STEP_TOOL, {}, at, 't'),
    ];
    expect(settledProgress(steps).map((step) => step.tool)).toEqual([
      'get_week_plan',
      'apply_week_plan',
    ]);
    // Nie rusza wejścia: lista na żywo jest dalej pełna.
    expect(steps).toHaveLength(6);
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
