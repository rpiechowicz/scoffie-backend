/**
 * Pamięć JEDNEJ tury asystenta (workstream, Etap 3.7).
 *
 * Prompt, narzędzia i planer tej samej tury czytały te same dane domu po
 * kilka razy: domownicy z celami (`memberPreferences`) szli do bazy przy
 * budowie promptu, przy `get_household_context`, przy `build_meal_plan`
 * i jeszcze raz przy filtrze zgód — do czterech razy w typowej turze.
 * W obrębie tury (sekundy, najwyżej minuty) te dane się nie zmieniają,
 * a model i tak widzi ich migawkę z początku tury w bloku gospodarstwa.
 *
 * Tylko proces i tylko tura: obiekt żyje w `AgentTurnRunner.run` i ginie
 * z nią — bez Redisa, bez unieważniania między turami. Pamiętamy WYŁĄCZNIE
 * odczyty, które tura sama zmienić nie może (skład domu, profile, pory,
 * zgody). Planu tygodnia tu nie ma: `apply_week_plan` w trybie zapisu
 * zmienia go w trakcie tury, więc każde narzędzie czyta go świeżo.
 *
 * Zapisy i tak sprawdzają członkostwo we własnej transakcji
 * (`ensureMembershipInTx`), więc pamięć nie osłabia żadnej bramki zapisu.
 */
export class TurnMemo {
  private readonly values = new Map<string, Promise<unknown>>();
  /** Narzędzie, które postawiło kartę tej tury — patrz `claimCard`. */
  private cardTool: string | null = null;

  /** Wartość spod klucza; pierwsze wywołanie ładuje, kolejne dostają to samo. */
  once<T>(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.values.get(key) as Promise<T> | undefined;
    if (cached) return cached;
    const value = load();
    this.values.set(key, value);
    // Błąd nie zostaje w pamięci: następne wywołanie spróbuje od nowa,
    // zamiast do końca tury oddawać ten sam wyjątek.
    value.catch(() => {
      if (this.values.get(key) === value) this.values.delete(key);
    });
    return value;
  }

  /**
   * Jedna karta na turę. Wiadomość asystenta niesie JEDNĄ kartę, więc drugie
   * narzędzie kartowe w tej samej turze (także w tej samej rundzie, równolegle)
   * postawiłoby kartę, której nikt nie zobaczy — albo, przy dwóch
   * propozycjach, osierociłoby jedną z nich. Rezerwacja jest synchroniczna
   * (przed pierwszym `await`), więc z dwóch równoległych wywołań wygrywa
   * dokładnie jedno. Zwraca narzędzie, które już trzyma kartę, albo `null`.
   */
  claimCard(tool: string): string | null {
    if (this.cardTool !== null) return this.cardTool;
    this.cardTool = tool;
    return null;
  }

  /** Narzędzie kartowe odmówiło (błąd, naruszenia) — karta tury jest wolna. */
  releaseCard(tool: string): void {
    if (this.cardTool === tool) this.cardTool = null;
  }
}

export function createTurnMemo(): TurnMemo {
  return new TurnMemo();
}

/** `memo.once`, gdy jest pamięć tury; bez niej (testy, skrypty) — wprost. */
export function memoized<T>(
  memo: TurnMemo | undefined,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  return memo ? memo.once(key, load) : load();
}

/**
 * Klucze pamięci tury — jedno miejsce, żeby prompt, executor i planer
 * trafiały w ten sam wpis (literówka w kluczu = cichy drugi odczyt).
 */
export const TURN_KEYS = {
  /** `Household` (`name`, `enabledMealTypes`). */
  household: (householdId: string) => `household:${householdId}`,
  /** `HouseholdsService.memberPreferences` — wszyscy domownicy z celami. */
  members: (userId: string, householdId: string) =>
    `members:${userId}:${householdId}`,
  /** `AgentPromptService.membersForModel` na domownikach wyżej (zgody). */
  visible: (userId: string, householdId: string) =>
    `visible:${userId}:${householdId}`,
} as const;
