import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/app-exception';

/// Parses an ISO yyyy-mm-dd weekStart value, throwing a 400-level
/// AppException if the input isn't a parseable date.
export function parseWeekStart(weekStart: string): Date {
  const parsed = new Date(weekStart);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppException(
      'VALIDATION_ERROR',
      'Invalid weekStart date format',
      HttpStatus.BAD_REQUEST,
    );
  }
  return parsed;
}

/// Renders a Date as `yyyy-mm-dd` using the ISO timezone slice.
export function formatWeekStart(value: Date): string {
  return value.toISOString().slice(0, 10);
}
