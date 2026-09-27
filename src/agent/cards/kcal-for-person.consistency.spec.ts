import { MealType } from '@prisma/client';
import {
  BalanceMeal,
  servingsPerPerson,
  weeklyBalanceForMember,
} from '../../weekly-plans/utils/daily-balance.util';
import { kcalForPerson } from './agent-cards';

/**
 * Karta planu (`kcalForPerson`) i bilans dnia (`weeklyBalanceForMember`)
 * mają mówić o TYM SAMYM dniu osoby (noc 26/27.09, N5): karta obiecuje
 * „2 345 kcal”, bilans po „Zapisz” ma pokazać tyle samo (± zaokrąglenie
 * na posiłek). Przypadki losowe, deterministyczne.
 */
const MEALS: MealType[] = ['BREAKFAST', 'LUNCH', 'DINNER'];
const USERS = ['a', 'b', 'c'];

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

type Slot = {
  mealType: MealType;
  kcalPerServing: number;
  participantIds: string[];
  plannedServings: number | null;
  recipeServings: number;
};

function slotsFor(seed: number, members: number): Slot[] {
  const next = prng(seed);
  const slots: Slot[] = [];
  for (const meal of MEALS) {
    const count = Math.floor(next() * 3); // 0–2 pozycje w posiłku
    for (let i = 0; i < count; i += 1) {
      const shared = next() < 0.5;
      const who = shared
        ? []
        : USERS.slice(0, members).filter(() => next() < 0.6);
      const participantIds = who.length === 0 && !shared ? ['a'] : who;
      const eaters = participantIds.length || members;
      const recipeServings = 1 + Math.floor(next() * 4);
      const kcalPerServing = 150 + Math.floor(next() * 600);
      const plannedServings =
        next() < 0.3 ? null : Math.max(1, eaters + Math.floor(next() * 3) - 1);
      slots.push({
        mealType: meal,
        kcalPerServing,
        participantIds,
        plannedServings,
        recipeServings,
      });
    }
  }
  return slots;
}

describe('karta planu = bilans dnia (N5)', () => {
  it('kcal osoby na karcie zgadza się z bilansem na 300 losowych dniach', () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 300; seed += 1) {
      const members = 1 + (seed % 3);
      const slots = slotsFor(seed, members);
      const meals: BalanceMeal[] = slots.map((slot) => ({
        dayOfWeek: 'MON',
        mealType: slot.mealType,
        participantIds: slot.participantIds,
        eatenByUserIds: [],
        plannedServings: slot.plannedServings,
        recipe: {
          servings: slot.recipeServings,
          nutritionKcal: slot.kcalPerServing * slot.recipeServings,
          nutritionProtein: 0,
          nutritionFat: 0,
          nutritionCarbs: 0,
          nutritionFiber: 0,
        },
      }));
      // To, co karta dostaje z `previewWeekPlan` (udział liczony tą samą regułą).
      const cardSlots = slots.map((slot) => ({
        mealType: slot.mealType,
        kcalPerServing: slot.kcalPerServing,
        participantIds: slot.participantIds,
        servingsPerPerson: servingsPerPerson(
          {
            participantIds: slot.participantIds,
            plannedServings: slot.plannedServings,
          },
          members,
        ),
      }));
      for (const user of USERS.slice(0, members)) {
        const card = kcalForPerson(cardSlots, user);
        const [day] = weeklyBalanceForMember(meals, {
          memberId: user,
          householdMemberCount: members,
          days: ['MON'],
        });
        const tolerance = slots.length; // zaokrąglenie na pozycję
        if (Math.abs(card - day.planned.kcal) > tolerance) {
          failures.push(
            `seed ${seed} ${user}: karta ${card}, bilans ${day.planned.kcal}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
