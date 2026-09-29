import { HttpStatus } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { AppException } from '../../common/app-exception';
import { effectiveProcessEnv } from '../../config/runtime-overrides';

/**
 * Adresy udostępnionych przepisów — kontrakt z klientami i stroną
 * (`docs/plans/udostepnianie-przepisow/KONTRAKT.md`):
 *
 * - katalog: `https://scoffie.app/przepis/<slug>` (slug nadaje baza,
 *   trigger `recipe_assign_slug`);
 * - przepis gospodarstwa: `https://scoffie.app/przepis/u/<token>`.
 */

/** Slug przepisu katalogu — ten sam kształt, który produkuje `recipe_slug_base`. */
export const RECIPE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const RECIPE_SLUG_MAX_LENGTH = 80;

/** 16 bajtów w base64url bez dopełnienia = dokładnie 22 znaki. */
export const RECIPE_SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

const DEFAULT_WEB_BASE_URL = 'https://scoffie.app';

/**
 * Domena strony. Z env tylko po to, żeby staging i e2e nie drukowały linków
 * do produkcji; aplikacje i tak rozpoznają WYŁĄCZNIE `scoffie.app`.
 */
export function publicWebBaseUrl(): string {
  const raw = effectiveProcessEnv().PUBLIC_WEB_BASE_URL?.trim();
  return (raw || DEFAULT_WEB_BASE_URL).replace(/\/+$/g, '');
}

export function catalogRecipeUrl(slug: string): string {
  return `${publicWebBaseUrl()}/przepis/${slug}`;
}

export function sharedRecipeUrl(token: string): string {
  return `${publicWebBaseUrl()}/przepis/u/${token}`;
}

/**
 * 128 losowych bitów — nie da się ich zgadnąć, a link zostaje krótki.
 * Jawny w bazie świadomie (patrz komentarz przy `RecipeShare` w schemacie).
 */
export function generateRecipeShareToken(): string {
  return randomBytes(16).toString('base64url');
}

export function isRecipeSlug(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= RECIPE_SLUG_MAX_LENGTH &&
    RECIPE_SLUG_PATTERN.test(value)
  );
}

export function isRecipeShareToken(value: unknown): value is string {
  return typeof value === 'string' && RECIPE_SHARE_TOKEN_PATTERN.test(value);
}

/**
 * JEDNA odpowiedź na każdy powód, dla którego linku nie da się otworzyć:
 * brak przepisu, wycofany, zły albo wyłączony token, śmieci w adresie.
 * Różne odpowiedzi byłyby wyrocznią — dałoby się sprawdzać, który token
 * kiedyś istniał.
 */
export function recipeLinkNotFound(): AppException {
  return new AppException(
    'RECIPE_NOT_FOUND',
    'Ten przepis nie jest już dostępny.',
    HttpStatus.NOT_FOUND,
  );
}
