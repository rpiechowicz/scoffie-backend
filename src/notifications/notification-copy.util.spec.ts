import {
  buildHouseholdJoinedCopy,
  buildPlanSummary,
  buildShoppingSummary,
  describeWeek,
  extractFirstName,
  polishPlural,
} from './notification-copy.util';

/**
 * Testy pilnują tego, co odróżnia dzisiejsze powiadomienia od poprzednich:
 * jedno zdanie na CAŁĄ serię zmian zamiast jednego zdania na każdą zmianę.
 * Reguła składania tego zdania jest hierarchiczna i cicha — nikt jej nie
 * zobaczy w kodzie wywołującym, więc musi być przybita tutaj.
 */
describe('notification-copy', () => {
  const MONDAY = new Date('2026-08-24T10:00:00.000Z');

  describe('polishPlural', () => {
    it.each([
      [1, 'zmianę'],
      [2, 'zmiany'],
      [4, 'zmiany'],
      [5, 'zmian'],
      [12, 'zmian'],
      [14, 'zmian'],
      [22, 'zmiany'],
      [25, 'zmian'],
    ])('%i → %s', (count, expected) => {
      expect(polishPlural(count, 'zmianę', 'zmiany', 'zmian')).toBe(expected);
    });
  });

  describe('extractFirstName', () => {
    it('bierze imię z displayName', () => {
      expect(extractFirstName('Marek Kowalski')).toBe('Marek');
    });

    it('bierze część e-maila przed małpą, gdy nazwy brak', () => {
      expect(extractFirstName('ania.nowak@example.com')).toBe('Ania');
    });

    it('nie zostawia pustego autora', () => {
      expect(extractFirstName('   ')).toBe('Ktoś');
      expect(extractFirstName(null)).toBe('Ktoś');
    });
  });

  describe('describeWeek', () => {
    it('rozpoznaje bieżący tydzień', () => {
      expect(describeWeek('2026-08-24', MONDAY)).toBe('ten tydzień');
    });

    it('rozpoznaje przyszły tydzień', () => {
      expect(describeWeek('2026-08-31', MONDAY)).toBe('przyszły tydzień');
    });

    it('dalsze tygodnie podaje datą', () => {
      expect(describeWeek('2026-09-14', MONDAY)).toBe('tydzień od 14.09');
    });

    it('dzień w środku tygodnia zwija się do jego poniedziałku', () => {
      expect(describeWeek('2026-08-27', MONDAY)).toBe('ten tydzień');
    });
  });

  describe('buildPlanSummary', () => {
    it('pojedyncza zmiana slotu opisuje dzień i posiłek', () => {
      const copy = buildPlanSummary(
        'Marek',
        [
          {
            action: 'UPSERT_SLOT',
            weekStart: '2026-08-24',
            dayOfWeek: 'WED',
            mealType: 'DINNER',
          },
        ],
        MONDAY,
      );
      expect(copy.body).toBe('Marek zmienił/a kolację na środę.');
    });

    it('podmiana przepisu (usunięcie + dodanie w tym samym slocie) to JEDNA zmiana', () => {
      // To jest ścieżka „Zmień przepis" z klienta: `removeWeekSlot` +
      // `upsertWeekSlot` na tej samej kratce. Dwa zdarzenia, jedna decyzja
      // użytkownika — i wcześniej dwa sprzeczne powiadomienia pod rząd.
      const copy = buildPlanSummary(
        'Marek',
        [
          {
            action: 'REMOVE_SLOT',
            weekStart: '2026-08-24',
            dayOfWeek: 'WED',
            mealType: 'DINNER',
          },
          {
            action: 'UPSERT_SLOT',
            weekStart: '2026-08-24',
            dayOfWeek: 'WED',
            mealType: 'DINNER',
          },
        ],
        MONDAY,
      );
      expect(copy.body).toBe('Marek zmienił/a kolację na środę.');
    });

    it('samo usunięcie slotu mówi o usunięciu', () => {
      const copy = buildPlanSummary(
        'Marek',
        [
          {
            action: 'REMOVE_SLOT',
            weekStart: '2026-08-24',
            dayOfWeek: 'WED',
            mealType: 'DINNER',
          },
        ],
        MONDAY,
      );
      expect(copy.body).toBe('Marek usunął/ęła kolację z planu na środę.');
    });

    it('wiele slotów zwija się do liczby, a nie do listy zdań', () => {
      const copy = buildPlanSummary(
        'Marek',
        [
          {
            action: 'UPSERT_SLOT',
            weekStart: '2026-08-24',
            dayOfWeek: 'MON',
            mealType: 'BREAKFAST',
          },
          {
            action: 'UPSERT_SLOT',
            weekStart: '2026-08-24',
            dayOfWeek: 'TUE',
            mealType: 'LUNCH',
          },
          {
            action: 'REMOVE_SLOT',
            weekStart: '2026-08-24',
            dayOfWeek: 'WED',
            mealType: 'DINNER',
          },
        ],
        MONDAY,
      );
      expect(copy.body).toBe(
        'Marek wprowadził/a 3 zmiany w planie na ten tydzień.',
      );
    });

    it('wyczyszczenie tygodnia wygrywa z pojedynczymi slotami', () => {
      const copy = buildPlanSummary(
        'Marek',
        [
          {
            action: 'UPSERT_SLOT',
            weekStart: '2026-08-24',
            dayOfWeek: 'MON',
            mealType: 'BREAKFAST',
          },
          { action: 'CLEAR_PLAN', weekStart: '2026-08-24' },
        ],
        MONDAY,
      );
      expect(copy.body).toBe('Marek usunął/ęła plan na ten tydzień.');
    });

    it('zapis puli wygrywa z pojedynczymi slotami', () => {
      const copy = buildPlanSummary(
        'Marek',
        [
          {
            action: 'UPSERT_SLOT',
            weekStart: '2026-08-24',
            dayOfWeek: 'MON',
            mealType: 'BREAKFAST',
          },
          { action: 'SAVE_PLAN', weekStart: '2026-08-24' },
        ],
        MONDAY,
      );
      expect(copy.body).toBe('Marek ustawił/a plan na ten tydzień.');
    });
  });

  describe('buildShoppingSummary', () => {
    it('zlicza odhaczone produkty zamiast opisywać każdy', () => {
      const events = Array.from({ length: 12 }, () => ({
        action: 'SET_ITEM_CHECKED' as const,
        isChecked: true,
      }));
      expect(buildShoppingSummary('Ania', events)?.body).toBe(
        'Ania odhaczył/a 12 produktów na liście zakupów.',
      );
    });

    it('same odznaczenia nie są wiadomością', () => {
      expect(
        buildShoppingSummary('Ania', [
          { action: 'SET_ITEM_CHECKED', isChecked: false },
        ]),
      ).toBeNull();
    });

    it('zamknięcie listy wygrywa z odhaczeniami', () => {
      expect(
        buildShoppingSummary('Ania', [
          { action: 'SET_ITEM_CHECKED', isChecked: true },
          { action: 'ARCHIVE_LIST' },
        ])?.body,
      ).toBe('Ania zamknął/ęła listę zakupów.');
    });
  });

  describe('buildHouseholdJoinedCopy', () => {
    it('nazywa gospodarstwo, gdy je znamy', () => {
      expect(buildHouseholdJoinedCopy('Ania Nowak', 'Dom').body).toBe(
        'Ania dołączył/a do gospodarstwa „Dom".',
      );
    });

    it('radzi sobie bez nazwy gospodarstwa', () => {
      expect(buildHouseholdJoinedCopy('Ania Nowak', null).body).toBe(
        'Ania dołączył/a do Twojego gospodarstwa.',
      );
    });
  });
});
