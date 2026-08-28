import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/app-exception';

const WEEK_START_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/// `weekStart` jest kluczem tygodnia we wszystkich tabelach planu i listy
/// zakupów (`@@unique([householdId, weekStart])`), więc jeden tydzień musi
/// mieć dokładnie JEDNĄ reprezentację: datę kalendarzową `YYYY-MM-DD`, która
/// jest poniedziałkiem, zapisaną jako północ UTC. Dawniej przechodziło
/// wszystko, co `new Date` sparsuje — `2026-08-31T00:00:00+02:00` tworzyło
/// osobny wiersz obok `2026-08-31`, a niedziela zakładała osobny „tydzień”,
/// którego aplikacja nigdy nie pokazuje.
export function parseWeekStart(weekStart: string): Date {
  if (typeof weekStart !== 'string' || !WEEK_START_PATTERN.test(weekStart)) {
    throw invalidWeekStart();
  }
  const parsed = new Date(`${weekStart}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== weekStart
  ) {
    throw invalidWeekStart();
  }
  if (parsed.getUTCDay() !== 1) {
    throw invalidWeekStart();
  }
  return parsed;
}

/// Renders a Date as `yyyy-mm-dd` using the ISO timezone slice.
export function formatWeekStart(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function invalidWeekStart(): AppException {
  return new AppException(
    'VALIDATION_ERROR',
    'weekStart musi być poniedziałkiem w formacie YYYY-MM-DD',
    HttpStatus.BAD_REQUEST,
  );
}
