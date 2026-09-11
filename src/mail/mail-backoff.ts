/**
 * Kiedy ponowić nieudaną wysyłkę.
 *
 * Osobny plik i czysta funkcja, bo to jedyny fragment robotnika, który da się
 * sprawdzić bez zegara, bazy i sieci — a pomyłka tutaj jest droga w obie
 * strony: za krótko to dobijanie się do dostawcy, który właśnie oddaje 429,
 * za długo to „witaj w Scoffie" doręczone nazajutrz.
 *
 * Odstępy rosną, bo awaria dostawcy zwykle nie mija w sekundę, a pięć prób
 * rozłożonych tak jak niżej daje niecałe dziewięć godzin okna — tyle wystarczy
 * na każdą przerwę, po której doręczenie ma jeszcze sens.
 */
const SCHEDULE_MS: readonly number[] = [
  60_000, // 1 min
  5 * 60_000, // 5 min
  30 * 60_000, // 30 min
  2 * 60 * 60_000, // 2 h
  6 * 60 * 60_000, // 6 h
];

/**
 * @param attempts ile prób JUŻ było (wiersz po nieudanej pierwszej ma 1)
 * @returns zwłoka do następnej próby w ms; po wyczerpaniu tablicy ostatni odstęp
 */
export function retryDelayMs(attempts: number): number {
  const index = Math.max(0, Math.floor(attempts) - 1);
  return SCHEDULE_MS[Math.min(index, SCHEDULE_MS.length - 1)];
}

export function nextAttemptAt(attempts: number, now: Date): Date {
  return new Date(now.getTime() + retryDelayMs(attempts));
}

/** Ile prób ma sens — używane w teście parytetu z `MAIL_MAX_ATTEMPTS`. */
export const RETRY_SCHEDULE_LENGTH = SCHEDULE_MS.length;
