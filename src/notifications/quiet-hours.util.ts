/**
 * Cisza nocna dla powiadomień zbiorczych.
 *
 * Okno jest stałe w kodzie, a nie w bazie, i tak ma zostać do czasu, aż ktoś
 * poprosi o własne godziny: para kolumn `start`/`end` w `UserPreference`
 * wymagałaby też ekranu do ich ustawiania, a dopóki wszyscy chcą tego samego
 * „nie budź mnie w nocy", jedna flaga `pushQuietHours` załatwia sprawę.
 */
export const QUIET_HOURS_START_MINUTE = 22 * 60;
export const QUIET_HOURS_END_MINUTE = 7 * 60;

/**
 * Strefa użytkownika bierze się z telefonu (`TimeZone.current.identifier`).
 * Fallback jest polski, bo aplikacja jest polska — liczenie ciszy nocnej w UTC
 * przesunęłoby ją latem o dwie godziny i wyciszało powiadomienia od północy.
 */
export const DEFAULT_TIME_ZONE = 'Europe/Warsaw';

/**
 * Minuty od północy w podanej strefie. `Intl` zamiast ręcznej arytmetyki na
 * offsetach, bo tylko ono zna zmiany czasu — a te wypadają w środku nocy,
 * czyli dokładnie w oknie, o które tu chodzi.
 */
export function minutesOfDayInZone(now: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

/**
 * Ile milisekund czekać, zanim wolno wysłać. `0` znaczy „można teraz".
 *
 * Zwracamy odroczenie, a nie `boolean`, bo powiadomienie ma dojechać rano, a
 * nie zniknąć: paczka czeka do końca okna i wychodzi jako jedno podsumowanie.
 */
export function quietHoursDeferralMs(
  now: Date,
  timeZone: string | null | undefined,
): number {
  const zone = timeZone?.trim() || DEFAULT_TIME_ZONE;

  let minuteOfDay: number;
  try {
    minuteOfDay = minutesOfDayInZone(now, zone);
  } catch {
    // Nieznana strefa z klienta (literówka, egzotyczny identyfikator) nie może
    // wywrócić wysyłki — wtedy liczymy po polsku.
    minuteOfDay = minutesOfDayInZone(now, DEFAULT_TIME_ZONE);
  }

  // Okno przechodzi przez północ, więc to suma dwóch przedziałów, nie jeden.
  const isNight =
    minuteOfDay >= QUIET_HOURS_START_MINUTE ||
    minuteOfDay < QUIET_HOURS_END_MINUTE;
  if (!isNight) {
    return 0;
  }

  const minutesUntilEnd =
    minuteOfDay < QUIET_HOURS_END_MINUTE
      ? QUIET_HOURS_END_MINUTE - minuteOfDay
      : 24 * 60 - minuteOfDay + QUIET_HOURS_END_MINUTE;

  return minutesUntilEnd * 60 * 1000;
}
