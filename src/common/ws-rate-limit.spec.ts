import { AppException } from './app-exception';
import {
  checkWsRateLimit,
  readWsRateLimit,
  resetWsRateLimits,
  WS_RATE_LIMIT_DEFAULT,
  WS_RATE_LIMIT_WINDOW_MS,
} from './ws-rate-limit';

describe('ws-rate-limit', () => {
  const original = process.env.WS_RATE_LIMIT_PER_MIN;

  beforeEach(() => {
    resetWsRateLimits();
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.WS_RATE_LIMIT_PER_MIN;
    } else {
      process.env.WS_RATE_LIMIT_PER_MIN = original;
    }
    resetWsRateLimits();
  });

  describe('readWsRateLimit', () => {
    it.each([
      ['brak', undefined, WS_RATE_LIMIT_DEFAULT],
      ['0 = wyłączony', '0', 0],
      ['własna wartość', '5', 5],
      ['śmieci → domyślna', 'dużo', WS_RATE_LIMIT_DEFAULT],
      ['ujemna → domyślna', '-2', WS_RATE_LIMIT_DEFAULT],
    ])('%s', (_label, value, expected) => {
      const env = (
        value === undefined ? {} : { WS_RATE_LIMIT_PER_MIN: value }
      ) as NodeJS.ProcessEnv;
      expect(readWsRateLimit(env)).toBe(expected);
    });
  });

  it('przepuszcza do limitu, potem rzuca TOO_MANY_REQUESTS z retryAfterSeconds', () => {
    process.env.WS_RATE_LIMIT_PER_MIN = '3';
    const t0 = 1_000_000;

    for (let i = 0; i < 3; i += 1) {
      expect(() => checkWsRateLimit('user-a', t0 + i)).not.toThrow();
    }

    try {
      checkWsRateLimit('user-a', t0 + 3);
      throw new Error('oczekiwano odmowy');
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      const exception = error as AppException;
      expect(exception.code).toBe('TOO_MANY_REQUESTS');
      expect(exception.getStatus()).toBe(429);
      expect(exception.details?.[0]).toMatch(/^retryAfterSeconds:\d+$/);
    }
  });

  it('liczy limit osobno dla każdego użytkownika', () => {
    process.env.WS_RATE_LIMIT_PER_MIN = '1';
    checkWsRateLimit('user-a', 1_000);
    expect(() => checkWsRateLimit('user-b', 1_000)).not.toThrow();
    expect(() => checkWsRateLimit('user-a', 1_000)).toThrow(AppException);
  });

  it('okno się przesuwa — po minucie limit wraca', () => {
    process.env.WS_RATE_LIMIT_PER_MIN = '1';
    checkWsRateLimit('user-a', 1_000);
    expect(() => checkWsRateLimit('user-a', 1_500)).toThrow(AppException);
    expect(() =>
      checkWsRateLimit('user-a', 1_000 + WS_RATE_LIMIT_WINDOW_MS),
    ).not.toThrow();
  });

  it('odrzucone wywołanie nie przedłuża blokady', () => {
    process.env.WS_RATE_LIMIT_PER_MIN = '1';
    checkWsRateLimit('user-a', 0);
    // Seria odbić w środku okna: gdyby każde zapisywało próbę, użytkownik
    // nigdy nie wyszedłby z blokady.
    for (let at = 1; at < WS_RATE_LIMIT_WINDOW_MS; at += 1_000) {
      expect(() => checkWsRateLimit('user-a', at)).toThrow(AppException);
    }
    expect(() =>
      checkWsRateLimit('user-a', WS_RATE_LIMIT_WINDOW_MS),
    ).not.toThrow();
  });

  it('WS_RATE_LIMIT_PER_MIN=0 wyłącza limiter', () => {
    process.env.WS_RATE_LIMIT_PER_MIN = '0';
    for (let i = 0; i < 500; i += 1) {
      expect(() => checkWsRateLimit('user-a', 1_000)).not.toThrow();
    }
  });
});
