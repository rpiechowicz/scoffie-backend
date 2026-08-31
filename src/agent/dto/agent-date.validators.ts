import { registerDecorator, ValidationOptions } from 'class-validator';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` bez przewijania (`2026-02-31` to nie jest data). */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return false;
  return date.toISOString().slice(0, 10) === value;
}

export function isMondayDate(value: unknown): value is string {
  if (!isCalendarDate(value)) return false;
  return new Date(`${value}T00:00:00.000Z`).getUTCDay() === 1;
}

export function isIanaTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    return false;
  }
  try {
    // Jedyny sposób, żeby sprawdzić strefę bez własnej listy: Intl rzuca
    // RangeError na nieznanej nazwie.
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Trzy dekoratory, bo daty asystenta liczy TELEFON, nie serwer.
 *
 * Railway żyje w UTC — gdyby backend sam wyznaczał „dziś" i początek
 * tygodnia, użytkownik w Warszawie dostałby po 22:00 plan na wczoraj (ten sam
 * powód, dla którego `SendToWeekDto.date` jest gołym stringiem). Klient
 * przysyła więc `weekStart` (poniedziałek), `clientToday` i swoją strefę, a
 * my tylko sprawdzamy, czy to w ogóle daty.
 */
export function IsCalendarDate(options?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'isCalendarDate',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => isCalendarDate(value),
        defaultMessage: () =>
          `${propertyName} musi być datą w formacie YYYY-MM-DD`,
      },
    });
  };
}

export function IsMondayDate(options?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'isMondayDate',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => isMondayDate(value),
        defaultMessage: () =>
          `${propertyName} musi być poniedziałkiem w formacie YYYY-MM-DD`,
      },
    });
  };
}

export function IsIanaTimeZone(options?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'isIanaTimeZone',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => isIanaTimeZone(value),
        defaultMessage: () =>
          `${propertyName} musi być nazwą strefy IANA, np. Europe/Warsaw`,
      },
    });
  };
}
