import { resolveWsAuthMode, wsAuthModeProblem } from './ws-auth-mode';

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
});
