import {
  applyDecorators,
  Controller,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { AdminGuard } from './admin.guard';
import { AdminAuthExceptionFilter } from './auth/admin-auth.errors';

/**
 * Kontroler panelu: trasy pod `/admin/<path>`, zawsze za `AdminGuard`
 * (bramka Access → sesja → uprawnienie → step-up), z filtrem błędów
 * logowania i BEZ globalnego throttlera — ten biegłby przed bramką i jego
 * 429 zdradzałoby istnienie trasy (limit liczy `AdminRateLimiter` po bramce).
 *
 * Jeden dekorator zamiast czterech przy każdej klasie: kontroler panelu bez
 * bramki nie może powstać przez przeoczenie.
 */
export function AdminController(path = ''): ClassDecorator {
  const route = path ? `admin/${path.replace(/^\/+|\/+$/g, '')}` : 'admin';
  return applyDecorators(
    Controller(route),
    UseGuards(AdminGuard),
    UseFilters(AdminAuthExceptionFilter),
    SkipThrottle({ default: true, ip: true }),
  );
}
