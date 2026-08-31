import { APP_ERROR_CODES, isAppErrorCode } from './app-error-code';

describe('APP_ERROR_CODES', () => {
  it('bez duplikatów, SCREAMING_SNAKE_CASE', () => {
    expect(new Set(APP_ERROR_CODES).size).toBe(APP_ERROR_CODES.length);
    for (const code of APP_ERROR_CODES) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
  });

  it('zawiera kody generyczne i domenowe, na których polega klient', () => {
    expect(APP_ERROR_CODES).toEqual(
      expect.arrayContaining([
        'VALIDATION_ERROR',
        'INTERNAL_ERROR',
        'RECIPE_NOT_FOUND',
        'INGREDIENT_NOT_FOUND',
        'PLAN_ITEM_NOT_FOUND',
        'SHOPPING_LIST_ARCHIVE_NOT_FOUND',
        'SHOPPING_ITEM_NOT_FOUND',
        'AI_DISABLED',
        'AI_QUOTA_EXCEEDED',
        'AI_TURN_IN_PROGRESS',
      ]),
    );
  });

  it('isAppErrorCode', () => {
    expect(isAppErrorCode('NOT_FOUND')).toBe(true);
    expect(isAppErrorCode('HTTP_ERROR')).toBe(false);
    expect(isAppErrorCode(42)).toBe(false);
  });
});
