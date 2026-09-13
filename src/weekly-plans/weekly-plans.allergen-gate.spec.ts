import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// AUDYT 12.09.2026 (P0.6). Bramka alergenowa jest twarda i liczy ją SERWER,
// nie model — to jest w tym produkcie decyzja bezpieczeństwa, nie wygody:
// danie z alergenem domownika może skończyć się wstrząsem anafilaktycznym,
// a model wnioskuje o składzie z digestu przyciętego do pięciu najcięższych
// składników („dorsz z masłem" wygląda stamtąd na danie bez nabiału).
//
// Testy zachowania bramki są w `weekly-plans.preview.spec.ts`,
// `agent-proposals.apply.spec.ts` i w e2e. Ten plik pilnuje czegoś innego
// i taniej: żeby NOWA ścieżka zapisu nie ominęła bramki przez przeoczenie.
// Dokładnie tak wygląda ryzyko przy izolacji czysto aplikacyjnej — jeden
// handler dopisany bez bramki i ochrona przestaje istnieć dla tej drogi.

const SERVICE = readFileSync(
  join(__dirname, 'weekly-plans.service.ts'),
  'utf8',
);

/** Ciało metody od jej sygnatury do następnej metody na tym samym wcięciu. */
const bodyOf = (name: string): string => {
  const start = SERVICE.indexOf(`\n  async ${name}(`);
  if (start === -1) throw new Error(`nie ma metody ${name}`);
  const rest = SERVICE.slice(start + 1);
  const next = rest.search(/\n {2}(async |private |\/\*\*)/);
  return next === -1 ? rest : rest.slice(0, next);
};

describe('WeeklyPlansService — twarda bramka alergenowa', () => {
  /** Metody, które WSTAWIAJĄ przepis do planu albo obiecują, co się stanie. */
  const zapisujace = ['upsertWeekSlot', 'applyWeekPlan', 'previewWeekPlan'];

  it.each(zapisujace)(
    '%s czyta ograniczenia domowników i liczy naruszenia',
    (name) => {
      const body = bodyOf(name);
      expect(body).toContain('loadHouseholdMembersForGate');
      expect(body).toContain('collectPlanViolations');
    },
  );

  it('każda metoda tworząca PlanItem przechodzi przez bramkę', () => {
    // Nie lista nazw utrzymywana ręcznie, tylko przeszukanie pliku: nowa
    // metoda z `planItem.create` bez bramki zapali ten test od razu.
    const metody = [...SERVICE.matchAll(/\n {2}async ([a-zA-Z]+)\(/g)].map(
      (match) => match[1],
    );
    const tworzace = metody.filter((name) => {
      const body = bodyOf(name);
      return (
        body.includes('planItem.create') || body.includes('planItem.upsert')
      );
    });

    expect(tworzace.length).toBeGreaterThan(0);
    for (const name of tworzace) {
      expect({
        metoda: name,
        maBramke: bodyOf(name).includes('loadHouseholdMembersForGate'),
      }).toEqual({ metoda: name, maBramke: true });
    }
  });

  it('bramka nie da się wyłączyć flagą ani zmienną środowiskową', () => {
    // Gdyby kiedykolwiek powstał przełącznik „pomiń walidację", to jest
    // miejsce, w którym ma zapalić się czerwone światło.
    const gate = SERVICE.slice(
      SERVICE.indexOf('private collectPlanViolations'),
      SERVICE.indexOf('private collectPlanViolations') + 6000,
    );
    expect(gate).not.toMatch(/process\.env/);
    expect(gate).not.toMatch(/skipValidation|force|ignoreAllergens/i);
  });

  it('audytorium puste znaczy CAŁY DOM, nie „nikogo"', () => {
    // Najgroźniejsza możliwa pomyłka w tej bramce: pusta lista uczestników
    // zinterpretowana jako „nikt nie je", czyli brak alergika do sprawdzenia.
    const gate = SERVICE.slice(
      SERVICE.indexOf('private collectPlanViolations'),
    );
    expect(gate).toContain('(slot.participantIds ?? []).length > 0');
  });
});
