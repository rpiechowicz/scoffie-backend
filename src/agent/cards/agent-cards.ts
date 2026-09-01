import { DayOfWeek, MealType } from '@prisma/client';
import { AiCardsMode } from '../../config/agent-env';

/**
 * Karty asystenta — kontrakt z TELEFONEM.
 *
 * Odpowiedź asystenta przestaje być akapitem: `AgentMessage.kind` mówi, czym
 * jest wiadomość, a `AgentMessage.card` niesie jej treść w kształcie, który
 * klient potrafi narysować i na którym potrafi umieścić przycisk.
 *
 * Trzy zasady, od których zależy, czy to się nie rozjedzie:
 *
 * 1. **Liczby i nazwy składa SERWER z bazy.** Model wskazuje wyłącznie
 *    identyfikatory. Kalorie przepisane z pamięci modelu wyglądałyby tak samo
 *    jak prawdziwe i nie byłoby jak odróżnić jednych od drugich.
 * 2. **`text` wiadomości broni się sam.** Karta jest DODATKIEM — klient, który
 *    jej nie zna (starszy build, nowy `kind`), pokazuje zdanie i nic nie traci.
 * 3. **Etykiety są gotowymi polskimi napisami**, jak `progress[].label`. Nowy
 *    rodzaj karty nie wymaga wtedy wydania aplikacji, a klient nie tłumaczy
 *    kodów slotów — tego samego zabrania modelowi prompt systemowy.
 */
export const AGENT_MESSAGE_KINDS = [
  'TEXT',
  'PLAN_WEEK',
  'PLAN_DAY',
  'OPTIONS',
  'SWAP',
  'HOUSEHOLD_SPLIT',
  'MACRO_GAP',
  'SHOPPING_LIST',
  'CLARIFY',
  'APPLIED',
] as const;

export type AgentMessageKind = (typeof AGENT_MESSAGE_KINDS)[number];

export function isAgentMessageKind(value: unknown): value is AgentMessageKind {
  return (
    typeof value === 'string' &&
    (AGENT_MESSAGE_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Wersja kontraktu karty.
 *
 * Reguła: w obrębie wersji pola tylko się DODAJE i zawsze jako opcjonalne.
 * Zmiana łamiąca podbija `v`, a serwer emituje starą wersję do czasu adopcji
 * buildu — tak samo jak przy `WS_AUTH_MODE`.
 */
export const AGENT_CARD_VERSION = 1;

/**
 * Deklaracja klienta: „umiem narysować kartę".
 *
 * Idzie w `PostMessageDto.clientCapabilities`, a nie w nagłówku ani w wersji
 * builda, bo pyta o UMIEJĘTNOŚĆ, nie o wersję. Build, który dostał karty,
 * i build, który je dopiero dostanie, różnią się dokładnie tym jednym.
 */
export const CARDS_CAPABILITY_V1 = 'cards.v1';

/**
 * Czy ta tura pracuje w trybie propozycji.
 *
 * Jedno miejsce na pytanie „kto zapisuje plan: model czy człowiek", bo
 * odpowiedź musi być IDENTYCZNA w trzech miejscach naraz — w prompcie
 * (co model ma robić), w executorze (czego mu nie wolno) i w kliencie
 * (co zobaczy). Rozjazd któregokolwiek z nich kończy się turą, w której model
 * obiecuje zapisany plan, a plan się nie zapisał.
 *
 * `soft` pyta klienta, bo tryb propozycji bez karty to ślepy zaułek: stary
 * build pokazałby zdanie „zaproponowałem" i ani jednego przycisku.
 */
export function resolveProposalMode(
  mode: AiCardsMode,
  clientCapabilities: readonly string[] | undefined,
): boolean {
  if (mode === 'off') return false;
  if (mode === 'strict') return true;
  return (clientCapabilities ?? []).includes(CARDS_CAPABILITY_V1);
}

/**
 * Przycisk w karcie. Napis przychodzi z serwera, klient go nie wymyśla.
 *
 * `ASK` jest osobnym rodzajem od reszty, bo NIE ZMIENIA NICZEGO: wysyła
 * w rozmowę gotowe zdanie z `prompt`, tak jakby użytkownik je napisał.
 * To jest cała mechanika „gotowych odpowiedzi” pod pytaniem asystenta i
 * wyboru z karuzeli — kliknięcie kosztuje turę, ale nie dotyka planu, więc
 * nie potrzebuje ani propozycji, ani kwoty planów.
 */
export type AgentCardAction = {
  type: 'APPLY' | 'UNDO' | 'OPEN_PLAN' | 'OPEN_SHOPPING' | 'ASK';
  proposalId: string | null;
  label: string;
  style: 'PRIMARY' | 'SECONDARY';
  /** Wyłącznie dla `ASK`: treść, którą klient wyśle jako wiadomość. */
  prompt?: string;
};

/**
 * Stan karty liczony PRZY ODCZYCIE, nigdy zapisywany.
 *
 * Karta w historii jest żywym sterownikiem, nie zdjęciem: po tygodniu, na
 * drugim telefonie i po ręcznej zmianie planu ma pokazywać prawdę o tym, czy
 * przycisk jeszcze cokolwiek zrobi.
 */
export type AgentCardState = {
  status: 'PENDING' | 'APPLIED' | 'UNDONE' | 'STALE' | 'EXPIRED' | 'FAILED';
  canApply: boolean;
  canUndo: boolean;
  /** Do kiedy da się kliknąć (ISO 8601); `null` = bez terminu. */
  until: string | null;
};

export type PlanWeekCardSlot = {
  mealType: MealType;
  /** „Obiad” — klient nie pokazuje kodów slotów. */
  mealLabel: string;
  recipeId: string;
  title: string;
  /** Kalorie NA PORCJĘ — karta mówi o talerzu, nie o garnku. */
  kcalPerServing: number;
  prepTimeMinutes: number;
  /** Miniatura dania; `null`, gdy przepis nie ma zdjęcia. */
  imageUrl: string | null;
  /** Puste = całe gospodarstwo. */
  participantIds: string[];
  change: 'NEW' | 'KEPT';
};

export type PlanWeekCardDay = {
  dayOfWeek: DayOfWeek;
  /** „Poniedziałek”. */
  dayLabel: string;
  /** „Pon” — siedem dni musi zmieścić się w karcie bez przewijania. */
  dayShort: string;
  /** `YYYY-MM-DD` — policzone z `weekStart`, nie przez model. */
  date: string;
  /** „1.09” — data po ludzku, obok skrótu dnia. */
  dateLabel: string;
  slots: PlanWeekCardSlot[];
  /** Suma kalorii dnia na osobę — po tym widać, czy plan dowozi cel. */
  kcalTotal: number;
};

export type PlanWeekCardRemoval = {
  dayLabel: string;
  mealLabel: string;
  title: string;
};

export type PlanWeekCard = {
  kind: 'PLAN_WEEK';
  v: number;
  proposalId: string;
  weekStart: string;
  /**
   * „Propozycja planu” — nadtytuł karty.
   *
   * Zakres dat idzie OSOBNO (`eyebrowDetail`), a nie doklejony kropką: razem
   * nie mieszczą się w jednym wierszu i łamią się w środku nazwy miesiąca.
   */
  eyebrow: string;
  /** „31 sierpnia – 6 września” — wiersz pod nadtytułem; `null`, gdy zbędny. */
  eyebrowDetail: string | null;
  title: string;
  /** Jedno zdanie modelu „dlaczego tak”; `null`, gdy nic nie dopisał. */
  subtitle: string | null;
  days: PlanWeekCardDay[];
  /** Co ZNIKNIE po zapisaniu — zmiana planu nigdy nie jest cicha. */
  removed: PlanWeekCardRemoval[];
  summary: {
    meals: number;
    created: number;
    updated: number;
    removed: number;
    /** Średnia dzienna z pozycji propozycji (na osobę). */
    averageKcalPerDay: number;
    /** Cel pytającego; `null`, gdy nie ma go w preferencjach. */
    targetKcalPerDay: number | null;
    /**
     * „−40 kcal od celu” — sam pasek mówi „ile”, ale nie „ile brakuje”.
     * `null`, gdy nie ma celu, wobec którego można by to policzyć.
     */
    goalNote: string | null;
  };
  actions: AgentCardAction[];
  state: AgentCardState;
};

/**
 * Propozycja JEDNEGO dnia.
 *
 * Osobny rodzaj, a nie PLAN_WEEK z jednym dniem: dzień czyta się inaczej —
 * po kolei od śniadania, z sumą wobec celu na dole. Tydzień pokazuje układ,
 * dzień pokazuje talerz.
 */
export type PlanDayCard = {
  kind: 'PLAN_DAY';
  v: number;
  proposalId: string;
  weekStart: string;
  /** Dzień, którego dotyczy — `YYYY-MM-DD`. */
  date: string;
  eyebrow: string;
  eyebrowDetail: string | null;
  title: string;
  subtitle: string | null;
  slots: PlanWeekCardSlot[];
  removed: PlanWeekCardRemoval[];
  summary: {
    meals: number;
    /** Suma kalorii dnia na osobę. */
    kcalTotal: number;
    targetKcalPerDay: number | null;
    /** „zostaje 228” albo „ponad cel o 120”; `null` bez celu. */
    goalNote: string | null;
  };
  actions: AgentCardAction[];
  state: AgentCardState;
};

/** Jedna pozycja w karuzeli wyboru. */
export type OptionsCardItem = {
  recipeId: string;
  title: string;
  kcalPerServing: number;
  prepTimeMinutes: number;
  /** Zdjęcie z katalogu; `null`, gdy przepis go nie ma. */
  imageUrl: string | null;
  /** „Najszybsze”, „Najwięcej białka” — jedno słowo od modelu. */
  tag: string | null;
  /** Gotowe zdanie, które wyśle się po dotknięciu. */
  prompt: string;
};

/**
 * Kilka dań do wyboru.
 *
 * Karta bez propozycji i bez stanu: to jest PYTANIE zadane obrazkami.
 * Dotknięcie wysyła zwykłą wiadomość („Wybieram: …”), a dopiero odpowiedź
 * modelu kończy się propozycją, którą da się zatwierdzić. Wersja, w której
 * kliknięcie od razu zapisuje, wymagałaby policzenia N pełnych podglądów
 * tygodnia z góry — czyli zapłacenia za cztery propozycje, żeby użyć jednej.
 */
export type OptionsCard = {
  kind: 'OPTIONS';
  v: number;
  eyebrow: string;
  title: string;
  options: OptionsCardItem[];
  actions: AgentCardAction[];
};

/** Danie po jednej stronie podmiany. */
export type SwapCardSide = {
  recipeId: string;
  title: string;
  kcalPerServing: number;
  prepTimeMinutes: number;
};

/** Różnica, którą warto pokazać: „−18 min”, „−230 kcal”. */
export type SwapCardDelta = {
  value: string;
  label: string;
  /** Czy ta zmiana idzie w stronę, o którą prosił użytkownik. */
  good: boolean;
};

/**
 * Podmiana jednego dania.
 *
 * Karta pokazuje PRZED i PO, bo pytanie brzmi „co się zmieni”, a nie „co
 * będzie”. Sama nowa pozycja nie daje odpowiedzi, dla której użytkownik
 * o podmianę poprosił.
 */
export type SwapCard = {
  kind: 'SWAP';
  v: number;
  proposalId: string;
  weekStart: string;
  date: string;
  eyebrow: string;
  title: string;
  /** `null`, gdy slot był pusty — wtedy to nie podmiana, tylko dołożenie. */
  from: SwapCardSide | null;
  to: SwapCardSide;
  deltas: SwapCardDelta[];
  actions: AgentCardAction[];
  state: AgentCardState;
};

/** Jedna osoba przy wspólnym daniu. */
export type HouseholdSplitPortion = {
  userId: string;
  displayName: string;
  /** „2 100 kcal · bez laktozy” — cel i ograniczenia prosto z profilu. */
  goalLabel: string;
  /** Jak podać TEJ osobie; jedno zdanie od modelu. */
  note: string | null;
  /** Ile z tego dania przypada na nią. */
  kcal: number;
};

/**
 * Jedno danie, kilka talerzy.
 *
 * Karta odpowiada na pytanie, którego nie da się zadać planowi tygodnia:
 * „ugotuję jedno, ale jak to podać czterem osobom z czterema różnymi celami”.
 * Cele i ograniczenia idą z PROFILÓW — model dokłada wyłącznie sposób podania.
 */
export type HouseholdSplitCard = {
  kind: 'HOUSEHOLD_SPLIT';
  v: number;
  proposalId: string;
  weekStart: string;
  date: string;
  eyebrow: string;
  title: string;
  prepTimeMinutes: number;
  portions: HouseholdSplitPortion[];
  actions: AgentCardAction[];
  state: AgentCardState;
};

/** Zmiana, która domyka brak: „Twarożek zamiast musli (śr.)” +24 g. */
export type MacroGapBooster = {
  text: string;
  amount: number;
};

/** Makro, o którym mówi karta. */
export const MACRO_KEYS = ['PROTEIN', 'FAT', 'CARBS', 'KCAL'] as const;
export type MacroKey = (typeof MACRO_KEYS)[number];

/**
 * Luka między planem a celem — i trzy rzeczy, które ją domykają.
 *
 * Liczby liczy SERWER z bilansu tygodnia i celów z profilu; model dokłada
 * wyłącznie pomysły na zmianę. To jest rozdział, na którym stoi wiarygodność
 * tej karty: „brakuje 44 g białka” z pamięci modelu wyglądałoby identycznie
 * jak policzone, a nie znaczyłoby nic.
 */
export type MacroGapCard = {
  kind: 'MACRO_GAP';
  v: number;
  eyebrow: string;
  title: string;
  macro: MacroKey;
  /** „g” albo „kcal” — klient nie zgaduje jednostki. */
  unit: string;
  /** Średnia dzienna z planu. */
  current: number;
  /** Cel dzienny z profilu. */
  target: number;
  boosters: MacroGapBooster[];
  actions: AgentCardAction[];
};

/** Dział sklepu z pozycjami — lista zakupów czyta się po alejkach. */
export type ShoppingListCardGroup = {
  department: string;
  /** „Feta 2 op.” — nazwa z ilością, gotowa do pokazania. */
  items: string[];
};

/**
 * Czego brakuje na ten tydzień.
 *
 * UWAGA na nazwę: to NIE jest różnica wobec spiżarni. Aplikacja nie ma
 * spiżarni i nie wie, co użytkownik ma w domu — jedyne, co wie, to które
 * pozycje ktoś odhaczył. Karta mówi więc dokładnie tyle, ile serwer wie:
 * co plan wymaga i ile z tego jest już odhaczone. Udawanie różnicy wobec
 * zapasów byłoby liczbą wziętą znikąd.
 */
export type ShoppingListCard = {
  kind: 'SHOPPING_LIST';
  v: number;
  weekStart: string;
  eyebrow: string;
  title: string;
  groups: ShoppingListCardGroup[];
  /** Ile pozycji zostało do kupienia i ile już odhaczono. */
  summary: { remaining: number; checked: number };
  /** `null`, gdy nic nie odhaczono — pusta linia mówiłaby o niczym. */
  checkedNote: string | null;
  actions: AgentCardAction[];
};

/**
 * Pytanie asystenta z gotowymi odpowiedziami.
 *
 * Nie ma tu ani propozycji, ani stanu do kliknięcia — to jest wiadomość,
 * która ZATRZYMUJE zgadywanie. Model, który nie wie, czy gotujemy dla
 * czterech osób czy dla dwóch, ma zapytać raz i dostać odpowiedź jednym
 * dotknięciem, zamiast układać tydzień na chybił trafił.
 */
export type ClarifyCard = {
  kind: 'CLARIFY';
  v: number;
  question: string;
  /** Jedno zdanie, dlaczego pyta; `null`, gdy powód jest oczywisty. */
  hint: string | null;
  /** Gotowe odpowiedzi — każda wysyła się jak zwykła wiadomość. */
  actions: AgentCardAction[];
};

export type AppliedCard = {
  kind: 'APPLIED';
  v: number;
  proposalId: string;
  weekStart: string;
  title: string;
  /** „2 nowe pozycje, 1 usunięta · 1–7 września”. */
  subtitle: string;
  summary: { created: number; updated: number; removed: number };
  /**
   * Czego „Cofnij” NIE przywróci. Kaskada przy usuwaniu pozycji zabiera
   * odhaczone „zjedzone”, a użytkownik ma o tym wiedzieć PRZED kliknięciem.
   */
  notes: string[];
  actions: AgentCardAction[];
  state: AgentCardState;
};

export type AgentCard =
  | PlanWeekCard
  | PlanDayCard
  | OptionsCard
  | SwapCard
  | HouseholdSplitCard
  | MacroGapCard
  | ShoppingListCard
  | ClarifyCard
  | AppliedCard;

/** Nazwa posiłku w mianowniku — do etykiety wiersza w karcie. */
export const MEAL_LABELS: Record<MealType, string> = {
  BREAKFAST: 'Śniadanie',
  SECOND_BREAKFAST: 'II śniadanie',
  LUNCH: 'Obiad',
  AFTERNOON_SNACK: 'Podwieczorek',
  DINNER: 'Kolacja',
  SNACK: 'Przekąska',
};

/** Nazwa dnia w mianowniku — „Poniedziałek”, nie „na poniedziałek”. */
export const DAY_LABELS: Record<DayOfWeek, string> = {
  MON: 'Poniedziałek',
  TUE: 'Wtorek',
  WED: 'Środa',
  THU: 'Czwartek',
  FRI: 'Piątek',
  SAT: 'Sobota',
  SUN: 'Niedziela',
};

/** Skrót dnia — „Pon”. Siedem wierszy musi zmieścić się w karcie. */
export const DAY_SHORT_LABELS: Record<DayOfWeek, string> = {
  MON: 'Pon',
  TUE: 'Wt',
  WED: 'Śr',
  THU: 'Czw',
  FRI: 'Pt',
  SAT: 'Sob',
  SUN: 'Ndz',
};

/** Kolejność dni tygodnia — ta sama co w enumie Prismy. */
export const DAYS_IN_WEEK_ORDER: readonly DayOfWeek[] = [
  DayOfWeek.MON,
  DayOfWeek.TUE,
  DayOfWeek.WED,
  DayOfWeek.THU,
  DayOfWeek.FRI,
  DayOfWeek.SAT,
  DayOfWeek.SUN,
];

/**
 * Data dnia tygodnia liczona z poniedziałka.
 *
 * Model dat nie liczy (mówi o tym prompt), a karta pokazuje „Wtorek 2.09” —
 * więc liczy je serwer, w UTC, tak jak reszta planu tygodnia.
 */
export function dateForDay(weekStart: string, day: DayOfWeek): string {
  const index = DAYS_IN_WEEK_ORDER.indexOf(day);
  const base = new Date(`${weekStart}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + Math.max(0, index));
  return base.toISOString().slice(0, 10);
}

/** „1.09” — dzień i miesiąc, bez roku i bez zer wiodących. */
export function shortDateLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return `${parsed.getUTCDate()}.${String(parsed.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** „2 września” — data po ludzku, w UTC jak cały plan tygodnia. */
export function longDateLabel(date: string): string {
  return new Intl.DateTimeFormat('pl-PL', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00.000Z`));
}

/**
 * „1–7 września” albo „31 sierpnia – 6 września”.
 *
 * Zakres w jednym miesiącu nie powtarza nazwy miesiąca — to jest różnica
 * między nadtytułem, który się czyta, a takim, który się omija wzrokiem.
 *
 * Nazwa miesiąca MUSI wyjść z formatowania razem z dniem: `month: 'long'`
 * samo w sobie daje mianownik („sierpień”), a data po polsku wymaga
 * dopełniacza („31 sierpnia”). Odmiany nie da się dokleić regułą.
 */
export function weekRangeLabel(weekStart: string): string {
  const start = new Date(`${weekStart}T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  const endLabel = longDateLabel(end.toISOString().slice(0, 10));

  return start.getUTCMonth() === end.getUTCMonth()
    ? `${start.getUTCDate()}–${endLabel}`
    : `${longDateLabel(weekStart)} – ${endLabel}`;
}

/**
 * Zdanie o tym, jak plan wypada wobec celu.
 *
 * Bez celu nie ma zdania — wymyślona norma byłaby gorsza niż jej brak.
 * Różnice poniżej progu przemilczamy: „−12 kcal od celu” to szum, który
 * każe użytkownikowi szukać problemu tam, gdzie go nie ma.
 */
export function goalNote(
  value: number,
  target: number | null,
  { tolerance = 50 }: { tolerance?: number } = {},
): string | null {
  if (target === null || target <= 0) return null;
  const delta = value - target;
  if (Math.abs(delta) <= tolerance) return 'w celu';
  return delta < 0
    ? `${Math.abs(delta)} kcal poniżej celu`
    : `${delta} kcal ponad cel`;
}
