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
