import { buildRemoveMealCard } from './remove-meal-card';
import { AGENT_MESSAGE_KINDS, isAgentMessageKind } from './agent-cards';

const removed = {
  recipeId: 'r-1',
  title: 'Zapiekanka',
  kcalPerServing: 640,
  prepTimeMinutes: 55,
};

const base = {
  proposalId: 'p-1',
  weekStart: '2026-09-14',
  date: '2026-09-17',
  dayOfWeek: 'THU' as const,
  mealType: 'DINNER' as const,
  removed,
  expiresAt: new Date('2026-09-20T10:00:00.000Z'),
};

describe('buildRemoveMealCard', () => {
  it('rodzaj karty jest znany klientowi', () => {
    // Nieznany `kind` znaczy, że telefon narysuje sam tekst i przycisku
    // „Usuń z planu" nie będzie w ogóle.
    expect(isAgentMessageKind('REMOVE_MEAL')).toBe(true);
    expect(AGENT_MESSAGE_KINDS).toContain('REMOVE_MEAL');
  });

  it('przycisk mówi, że czegoś UBĘDZIE', () => {
    // To jedyna karta, po której z planu znika pozycja — „Zastosuj" nie mówi
    // tego, a użytkownik czyta napis, nie rodzaj karty.
    const card = buildRemoveMealCard(base);
    expect(card.actions).toEqual([
      {
        type: 'APPLY',
        proposalId: 'p-1',
        label: 'Usuń z planu',
        style: 'PRIMARY',
      },
    ]);
    expect(card.state).toMatchObject({ status: 'PENDING', canApply: true });
  });

  it('nadtytuł mówi, komu to znika', () => {
    expect(buildRemoveMealCard(base).eyebrow).toBe('Usunięcie · czwartek, kolacja');
    expect(
      buildRemoveMealCard({ ...base, forNames: ['Ania'] }).eyebrow,
    ).toBe('Usunięcie · czwartek, kolacja · tylko Ania');
    expect(
      buildRemoveMealCard({ ...base, forNames: ['Ania', 'Kuba'] }).eyebrow,
    ).toBe('Usunięcie · czwartek, kolacja · tylko Ania i Kuba');
  });

  it('krótki powód idzie w tytuł, długi w notatkę', () => {
    expect(buildRemoveMealCard({ ...base, reason: 'Jemy u teściów' }).title).toBe(
      'Jemy u teściów',
    );

    const long = 'a'.repeat(61);
    const card = buildRemoveMealCard({ ...base, reason: long });
    expect(card.title).toBe('Zapiekanka znika z planu');
    expect(card.note).toBe(long);
  });

  it('bez powodu tytuł nazywa danie, a nie slot', () => {
    const card = buildRemoveMealCard(base);
    expect(card.title).toBe('Zapiekanka znika z planu');
    expect(card.note).toBeNull();
  });
});
