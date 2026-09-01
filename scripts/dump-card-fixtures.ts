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
import { buildSwapCard } from '../src/agent/cards/swap-card';
import { buildOptionsCard, optionPrompt } from '../src/agent/cards/options-card';
import { buildHouseholdSplitCard } from '../src/agent/cards/household-split-card';
import { buildMacroGapCard } from '../src/agent/cards/macro-gap-card';
import { buildShoppingListCard } from '../src/agent/cards/shopping-list-card';
import { buildDetectedItemsCard } from '../src/agent/cards/detected-items-card';
import { ShoppingDepartment } from '../src/weekly-plans/types/shopping-department.enum';

const card = buildPlanWeekCard({
  proposalId: '55555555-5555-4555-8555-555555555555',
  weekStart: '2026-08-31',
  note: 'Nic się nie powtarza, a wtorek jest szybki.',
  preview: {
    violations: [],
    changes: { created: 2, updated: 0, deleted: 1 },
    slots: [
      { dayOfWeek: 'MON', mealType: 'LUNCH', recipeId: 'r-1', title: 'Kurczak z ryżem', kcalPerServing: 620, prepTimeMinutes: 30, imageUrl: 'https://example.invalid/kurczak.png', participantIds: [], change: 'NEW' },
      { dayOfWeek: 'MON', mealType: 'DINNER', recipeId: 'r-2', title: 'Sałatka z tuńczykiem', kcalPerServing: 380, prepTimeMinutes: 12, imageUrl: null, participantIds: ['u1'], change: 'KEPT' },
      { dayOfWeek: 'TUE', mealType: 'DINNER', recipeId: 'r-3', title: 'Placki ziemniaczane', kcalPerServing: 540, prepTimeMinutes: 40, imageUrl: null, participantIds: [], change: 'NEW' },
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
      { dayOfWeek: 'TUE', mealType: 'BREAKFAST', recipeId: 'r-4', title: 'Owsianka z bananem', kcalPerServing: 447, prepTimeMinutes: 12, imageUrl: null, participantIds: [], change: 'NEW' },
      { dayOfWeek: 'TUE', mealType: 'LUNCH', recipeId: 'r-1', title: 'Kurczak w sosie curry z ryżem', kcalPerServing: 620, prepTimeMinutes: 35, imageUrl: null, participantIds: [], change: 'KEPT' },
      { dayOfWeek: 'TUE', mealType: 'DINNER', recipeId: 'r-5', title: 'Omlet ze szpinakiem i fetą', kcalPerServing: 393, prepTimeMinutes: 12, imageUrl: null, participantIds: [], change: 'NEW' },
      { dayOfWeek: 'WED', mealType: 'DINNER', recipeId: 'r-6', title: 'Gulasz wołowy', kcalPerServing: 700, prepTimeMinutes: 55, imageUrl: null, participantIds: [], change: 'KEPT' },
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

const swap = buildSwapCard({
  proposalId: '77777777-7777-4777-8777-777777777777',
  weekStart: '2026-08-31',
  date: '2026-09-01',
  dayOfWeek: 'TUE',
  mealType: 'DINNER',
  from: { recipeId: 'r-1', title: 'Gulasz wołowy z kaszą', kcalPerServing: 720, prepTimeMinutes: 55 },
  to: { recipeId: 'r-5', title: 'Omlet ze szpinakiem i fetą', kcalPerServing: 393, prepTimeMinutes: 12 },
  reason: 'Żeby było szybciej',
  expiresAt: new Date('2026-09-03T10:00:00.000Z'),
});

const options = buildOptionsCard({
  title: 'Trzy szybkie kolacje',
  slotLabel: 'Kolacja · wtorek',
  options: [
    { recipeId: 'r-5', title: 'Omlet ze szpinakiem i fetą', kcalPerServing: 393, prepTimeMinutes: 12, imageUrl: 'https://example.invalid/omlet.jpg', tag: 'Najszybsze', prompt: optionPrompt('Omlet ze szpinakiem i fetą') },
    { recipeId: 'r-7', title: 'Sałatka z tuńczykiem', kcalPerServing: 340, prepTimeMinutes: 15, imageUrl: null, tag: null, prompt: optionPrompt('Sałatka z tuńczykiem') },
    { recipeId: 'r-8', title: 'Tost z awokado i jajkiem', kcalPerServing: 420, prepTimeMinutes: 10, imageUrl: null, tag: 'Najwięcej białka', prompt: optionPrompt('Tost z awokado i jajkiem') },
  ],
});

const householdSplit = buildHouseholdSplitCard({
  proposalId: '88888888-8888-4888-8888-888888888888',
  weekStart: '2026-08-31',
  date: '2026-09-02',
  dayOfWeek: 'WED',
  mealType: 'DINNER',
  title: 'Gulasz wołowy z kaszą gryczaną',
  prepTimeMinutes: 55,
  portions: [
    { userId: 'u-1', displayName: 'Rafał', goalLabel: '2100 kcal', note: 'Duża porcja + kasza 100 g', kcal: 740 },
    { userId: 'u-2', displayName: 'Ania', goalLabel: '1750 kcal · wegetariańska', note: 'Bez mięsa, więcej kaszy', kcal: 590 },
    { userId: 'u-3', displayName: 'Zosia', goalLabel: '1400 kcal · bez laktozy', note: 'Śmietana osobno', kcal: 420 },
  ],
  expiresAt: new Date('2026-09-03T10:00:00.000Z'),
});

const macroGap = buildMacroGapCard({
  macro: 'PROTEIN',
  current: 96,
  target: 140,
  scopeLabel: 'ten tydzień',
  boosters: [
    { text: 'Twarożek zamiast musli (śr.)', amount: 24 },
    { text: 'Jogurt grecki do owsianki (pon., czw.)', amount: 18 },
    { text: 'Kurczak zamiast makaronu na kolację (pt.)', amount: 22 },
  ],
});

const shoppingList = buildShoppingListCard({
  weekStart: '2026-08-31',
  departmentOrder: Object.values(ShoppingDepartment),
  items: [
    { name: 'Cukinia', unit: 'szt.', department: ShoppingDepartment.VEGETABLES, totalAmount: 2, isChecked: false },
    { name: 'Dynia', unit: 'kg', department: ShoppingDepartment.VEGETABLES, totalAmount: 1, isChecked: false },
    { name: 'Feta', unit: 'op.', department: ShoppingDepartment.DAIRY, totalAmount: 2, isChecked: false },
    { name: 'Dorsz', unit: 'g', department: ShoppingDepartment.FISH, totalAmount: 600, isChecked: false },
    { name: 'Kasza gryczana', unit: 'g', department: ShoppingDepartment.GRAINS, totalAmount: 500, isChecked: true },
  ],
});

const detectedItems = buildDetectedItemsCard({
  items: [
    { name: 'Jajka', sure: true },
    { name: 'Ser żółty', sure: true },
    { name: 'Coś w folii na dolnej półce', sure: false },
  ],
});

console.log(
  JSON.stringify(
    {
      planWeek: card,
      detectedItems,
      planDay,
      options,
      swap,
      householdSplit,
      macroGap,
      shoppingList,
      clarify,
      applied,
    },
    null,
    2,
  ),
);
