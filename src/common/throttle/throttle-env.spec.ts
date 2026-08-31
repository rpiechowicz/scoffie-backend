import {
  readThrottleLimit,
  THROTTLE_DEFAULTS,
  throttleEnvProblems,
} from './throttle-env';

describe('throttle-env', () => {
  describe('readThrottleLimit', () => {
    it('bierze wartość z env, gdy jest sensowna', () => {
      expect(
        readThrottleLimit('THROTTLE_AUTH_LIMIT', {
          THROTTLE_AUTH_LIMIT: '3',
        } as NodeJS.ProcessEnv),
      ).toBe(3);
    });

    it.each([
      ['brak zmiennej', {}],
      ['pusta', { THROTTLE_AUTH_LIMIT: '   ' }],
      ['nie-liczba', { THROTTLE_AUTH_LIMIT: 'dużo' }],
      ['ułamek', { THROTTLE_AUTH_LIMIT: '2.5' }],
      ['zero (limit 0 blokowałby wszystko)', { THROTTLE_AUTH_LIMIT: '0' }],
      ['ujemna', { THROTTLE_AUTH_LIMIT: '-1' }],
    ])('wraca do domyślnej: %s', (_label, env) => {
      expect(
        readThrottleLimit('THROTTLE_AUTH_LIMIT', env as NodeJS.ProcessEnv),
      ).toBe(THROTTLE_DEFAULTS.THROTTLE_AUTH_LIMIT);
    });
  });

  describe('throttleEnvProblems', () => {
    it('milczy przy pustym env — merge nie wymaga zmiennych na Railway', () => {
      expect(throttleEnvProblems({} as NodeJS.ProcessEnv)).toEqual([]);
    });

    it('zgłasza złą wartość limitu i podaje domyślną', () => {
      const problems = throttleEnvProblems({
        THROTTLE_DEFAULT_LIMIT: 'sto',
      } as NodeJS.ProcessEnv);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('THROTTLE_DEFAULT_LIMIT=sto');
      expect(problems[0]).toContain(
        String(THROTTLE_DEFAULTS.THROTTLE_DEFAULT_LIMIT),
      );
    });

    it('dopuszcza WS_RATE_LIMIT_PER_MIN=0 (limiter wyłączony), odrzuca ujemne', () => {
      expect(
        throttleEnvProblems({
          WS_RATE_LIMIT_PER_MIN: '0',
        } as NodeJS.ProcessEnv),
      ).toEqual([]);
      expect(
        throttleEnvProblems({
          WS_RATE_LIMIT_PER_MIN: '-5',
        } as NodeJS.ProcessEnv),
      ).toHaveLength(1);
    });
  });
});
