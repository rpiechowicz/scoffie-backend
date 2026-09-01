/**
 * Wzorce kart dla sprawdzianu kontraktu po stronie iOS.
 *
 * Karta jedzie na telefon JSON-em, a klient dekoduje ją pobłażliwie: rozjazd
 * nazwy pola nie daje żadnego błędu — karta staje się `.unknown` i po prostu
 * znika z ekranu. Ten skrypt drukuje odpowiedź serwera dosłownie, żeby
 * `Scripts/card-contract-check.sh` w repo iOS miał na czym stanąć.
 *
 * Buildery są czyste (nie ruszają bazy), więc skrypt nie potrzebuje niczego
 * poza kodem:
 *   docker exec weeklymeals-api sh -c 'cd /app && npx tsx scripts/dump-card-fixtures.ts'
 */
import { buildPlanWeekCard } from '../src/agent/cards/plan-week-card';
import { buildAppliedCard } from '../src/agent/cards/applied-card';
import { buildPlanDayCard } from '../src/agent/cards/plan-day-card';
import { buildClarifyCard } from '../src/agent/cards/clarify-card';

const card = buildPlanWeekCard({
  proposalId: '55555555-5555-4555-8555-555555555555',
  weekStart: '2026-08-31',
  note: 'Nic się nie powtarza, a wtorek jest szybki.',
  preview: {
    violations: [],
    changes: { created: 2, updated: 0, deleted: 1 },
    slots: [
      { dayOfWeek: 'MON', mealType: 'LUNCH', recipeId: 'r-1', title: 'Kurczak z ryżem', kcalPerServing: 620, prepTimeMinutes: 30, participantIds: [], change: 'NEW' },
      { dayOfWeek: 'MON', mealType: 'DINNER', recipeId: 'r-2', title: 'Sałatka z tuńczykiem', kcalPerServing: 380, prepTimeMinutes: 12, participantIds: ['u1'], change: 'KEPT' },
      { dayOfWeek: 'TUE', mealType: 'DINNER', recipeId: 'r-3', title: 'Placki ziemniaczane', kcalPerServing: 540, prepTimeMinutes: 40, participantIds: [], change: 'NEW' },
    ],
    removed: [{ dayOfWeek: 'WED', mealType: 'DINNER', title: 'Zupa pomidorowa' }],
  } as never,
  targetKcalPerDay: 2100,
  expiresAt: new Date('2026-09-03T10:00:00.000Z'),
});

const applied = buildAppliedCard({
  proposalId: '55555555-5555-4555-8555-555555555555',
  weekStart: '2026-08-31',
  changes: { created: 2, updated: 0, deleted: 1 },
  undoUntil: new Date('2026-08-31T11:00:00.000Z'),
  canUndo: true,
});

const planDay = buildPlanDayCard({
  proposalId: '66666666-6666-4666-8666-666666666666',
  weekStart: '2026-08-31',
  dayOfWeek: 'TUE',
  date: '2026-09-01',
  note: 'Lekki wieczór po ciężkim obiedzie.',
  preview: {
    violations: [],
    changes: { created: 2, updated: 0, deleted: 1 },
    slots: [
      { dayOfWeek: 'TUE', mealType: 'BREAKFAST', recipeId: 'r-4', title: 'Owsianka z bananem', kcalPerServing: 447, prepTimeMinutes: 12, participantIds: [], change: 'NEW' },
      { dayOfWeek: 'TUE', mealType: 'LUNCH', recipeId: 'r-1', title: 'Kurczak w sosie curry z ryżem', kcalPerServing: 620, prepTimeMinutes: 35, participantIds: [], change: 'KEPT' },
      { dayOfWeek: 'TUE', mealType: 'DINNER', recipeId: 'r-5', title: 'Omlet ze szpinakiem i fetą', kcalPerServing: 393, prepTimeMinutes: 12, participantIds: [], change: 'NEW' },
      { dayOfWeek: 'WED', mealType: 'DINNER', recipeId: 'r-6', title: 'Gulasz wołowy', kcalPerServing: 700, prepTimeMinutes: 55, participantIds: [], change: 'KEPT' },
    ],
    removed: [{ dayOfWeek: 'TUE', mealType: 'DINNER', title: 'Pizza mrożona' }],
  } as never,
  targetKcalPerDay: 2100,
  expiresAt: new Date('2026-09-03T10:00:00.000Z'),
});

const clarify = buildClarifyCard({
  question: 'Dla ilu osób mam planować ten tydzień?',
  hint: 'W profilu są cztery osoby, ale wspominałeś o weekendzie we dwoje.',
  options: ['Dla czterech', 'Dla dwóch', 'Inaczej w weekend'],
});

console.log(
  JSON.stringify({ planWeek: card, planDay, clarify, applied }, null, 2),
);
