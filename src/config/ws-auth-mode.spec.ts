import {
  resolveWsAuthMode,
  wsAuthModeProblem,
  wsAuthModeProductionProblem,
} from './ws-auth-mode';

describe('WS_AUTH_MODE', () => {
  it.each([
    [undefined, 'soft'],
    ['', 'soft'],
    ['soft', 'soft'],
    ['STRICT', 'strict'],
    [' strict ', 'strict'],
    ['off', 'soft'],
    ['required', 'soft'],
  ])('%p → %s', (raw, expected) => {
    expect(resolveWsAuthMode({ WS_AUTH_MODE: raw })).toBe(expected);
  });

  it('pusta/poprawna wartość to nie problem, literówka tak', () => {
    expect(wsAuthModeProblem({})).toBeNull();
    expect(wsAuthModeProblem({ WS_AUTH_MODE: 'strict' })).toBeNull();
    expect(wsAuthModeProblem({ WS_AUTH_MODE: 'stric' })).toContain(
      'WS_AUTH_MODE=stric',
    );
    expect(wsAuthModeProblem({ WS_AUTH_MODE: 'off' })).toContain(
      'soft, strict',
    );
  });

  it('brak zmiennej: strict na produkcji, soft poza nią', () => {
    expect(resolveWsAuthMode({ NODE_ENV: 'production' })).toBe('strict');
    expect(resolveWsAuthMode({ NODE_ENV: 'development' })).toBe('soft');
  });

  it('jawne soft na produkcji to naruszenie, poza produkcją nie', () => {
    expect(
      wsAuthModeProductionProblem({
        NODE_ENV: 'production',
        WS_AUTH_MODE: 'soft',
      }),
    ).toContain('WS_AUTH_MODE=soft');
    expect(
      wsAuthModeProductionProblem({
        NODE_ENV: 'production',
        WS_AUTH_MODE: 'strict',
      }),
    ).toBeNull();
    expect(wsAuthModeProductionProblem({ NODE_ENV: 'production' })).toBeNull();
    expect(
      wsAuthModeProductionProblem({
        NODE_ENV: 'development',
        WS_AUTH_MODE: 'soft',
      }),
    ).toBeNull();
  });
});
