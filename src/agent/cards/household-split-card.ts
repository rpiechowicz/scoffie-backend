import { DayOfWeek, MealType } from '@prisma/client';
import {
  AGENT_CARD_VERSION,
  DAY_LABELS,
  HouseholdSplitCard,
  HouseholdSplitPortion,
  MEAL_LABELS,
} from './agent-cards';

/**
 * Jedno danie, kilka talerzy.
 *
 * Cele i ograniczenia domowników bierzemy z PROFILÓW, nie od modelu: to są
 * dane, które użytkownik sam wpisał, i jedyne, po których pozna, że asystent
 * naprawdę je czytał. Model dokłada wyłącznie sposób podania — czyli to,
 * czego w profilu nie ma i nie będzie.
 */
export function buildHouseholdSplitCard(input: {
  proposalId: string;
  weekStart: string;
  date: string;
  dayOfWeek: DayOfWeek;
  mealType: MealType;
  title: string;
  prepTimeMinutes: number;
  portions: readonly HouseholdSplitPortion[];
  expiresAt: Date;
}): HouseholdSplitCard {
  return {
    kind: 'HOUSEHOLD_SPLIT',
    v: AGENT_CARD_VERSION,
    proposalId: input.proposalId,
    weekStart: input.weekStart,
    date: input.date,
    eyebrow: `Jedna baza · ${portionsLabel(input.portions.length)}`,
    title: input.title,
    prepTimeMinutes: input.prepTimeMinutes,
    portions: [...input.portions],
    actions: [
      {
        type: 'APPLY',
        proposalId: input.proposalId,
        label: `Zapisz na ${accusativeDay(input.dayOfWeek)}`,
        style: 'PRIMARY',
      },
    ],
    state: {
      status: 'PENDING',
      canApply: true,
      canUndo: false,
      until: input.expiresAt.toISOString(),
    },
  };
}

/**
 * Polskie nazwy alergenów i diet.
 *
 * Serwer ich dotąd nie potrzebował — tłumaczył je klient. Karta zmienia tę
 * zasadę świadomie: napisy przychodzą z serwera, żeby nowy rodzaj karty nie
 * wymagał wydania aplikacji. Identyfikatory są te same co w `ALLERGEN_IDS`.
 */
const ALLERGEN_LABELS: Readonly<Record<string, string>> = {
  gluten: 'glutenu',
  lactose: 'laktozy',
  eggs: 'jajek',
  nuts: 'orzechów',
  peanuts: 'orzeszków ziemnych',
  fish: 'ryb',
  soy: 'soi',
  celery: 'selera',
  mustard: 'gorczycy',
  sesame: 'sezamu',
};

const DIET_LABELS: Readonly<Record<string, string>> = {
  VEGETARIAN: 'wegetariańska',
  VEGAN: 'wegańska',
  PESCATARIAN: 'pescatariańska',
  KETO: 'keto',
  PALEO: 'paleo',
  HIGH_PROTEIN: 'wysokobiałkowa',
};

/** „2 100 kcal · bez laktozy” — cel i to, co go zawęża. */
export function goalLabel(input: {
  calorieGoal: number;
  dietPreference: string;
  allergens: readonly string[];
}): string {
  const parts: string[] = [`${input.calorieGoal} kcal`];
  const diet = DIET_LABELS[input.dietPreference];
  if (diet) parts.push(diet);
  // Alergeny wymieniamy do trzech: dłuższa lista i tak nie mieści się
  // w wierszu, a jej ogon jest mniej ważny niż imię obok.
  const named = input.allergens
    .map((allergen) => ALLERGEN_LABELS[allergen] ?? allergen)
    .slice(0, 3);
  if (named.length > 0) parts.push(`bez ${named.join(', ')}`);
  return parts.join(' · ');
}

function portionsLabel(count: number): string {
  if (count === 1) return 'jedna porcja';
  const words: Record<number, string> = {
    2: 'dwie porcje',
    3: 'trzy porcje',
    4: 'cztery porcje',
    5: 'pięć porcji',
    6: 'sześć porcji',
  };
  return words[count] ?? `${count} porcji`;
}

/** „środę”, nie „środa” — przycisk mówi zdaniem, a nie hasłem. */
function accusativeDay(day: DayOfWeek): string {
  const forms: Record<DayOfWeek, string> = {
    MON: 'poniedziałek',
    TUE: 'wtorek',
    WED: 'środę',
    THU: 'czwartek',
    FRI: 'piątek',
    SAT: 'sobotę',
    SUN: 'niedzielę',
  };
  return forms[day] ?? DAY_LABELS[day].toLowerCase();
}

/** Etykieta slotu do nadtytułu — „Kolacja · środa”. */
export function slotLabel(day: DayOfWeek, meal: MealType): string {
  return `${MEAL_LABELS[meal]} · ${DAY_LABELS[day].toLowerCase()}`;
}
