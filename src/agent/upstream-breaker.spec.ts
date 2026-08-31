import { UpstreamBreaker } from './upstream-breaker';

describe('UpstreamBreaker', () => {
  const options = { threshold: 3, windowMs: 1_000, openMs: 500 };

  it('otwiera się dopiero po progu błędów w oknie', () => {
    const breaker = new UpstreamBreaker(options);
    expect(breaker.recordFailure(0)).toBe(false);
    expect(breaker.recordFailure(100)).toBe(false);
    expect(breaker.isOpen(100)).toBe(false);
    expect(breaker.recordFailure(200)).toBe(true);
    expect(breaker.isOpen(200)).toBe(true);
  });

  it('zamyka się po `openMs`', () => {
    const breaker = new UpstreamBreaker(options);
    breaker.recordFailure(0);
    breaker.recordFailure(0);
    breaker.recordFailure(0);
    expect(breaker.isOpen(499)).toBe(true);
    expect(breaker.isOpen(500)).toBe(false);
  });

  it('nie liczy błędów sprzed okna', () => {
    const breaker = new UpstreamBreaker(options);
    breaker.recordFailure(0);
    breaker.recordFailure(100);
    // Ten wypada poza okno pierwszych dwóch — próg nieosiągnięty.
    expect(breaker.recordFailure(1_500)).toBe(false);
    expect(breaker.isOpen(1_500)).toBe(false);
  });

  it('po otwarciu liczy od zera — jeden błąd nie otwiera go ponownie', () => {
    const breaker = new UpstreamBreaker(options);
    breaker.recordFailure(0);
    breaker.recordFailure(0);
    expect(breaker.recordFailure(0)).toBe(true);
    expect(breaker.recordFailure(600)).toBe(false);
    expect(breaker.isOpen(600)).toBe(false);
  });

  it('udana tura kasuje historię', () => {
    const breaker = new UpstreamBreaker(options);
    breaker.recordFailure(0);
    breaker.recordFailure(10);
    breaker.recordSuccess();
    expect(breaker.recordFailure(20)).toBe(false);
  });

  it('retryAfterSeconds zaokrągla w górę i nie schodzi poniżej 1', () => {
    const breaker = new UpstreamBreaker({ ...options, openMs: 60_000 });
    breaker.recordFailure(0);
    breaker.recordFailure(0);
    breaker.recordFailure(0);
    expect(breaker.retryAfterSeconds(0)).toBe(60);
    expect(breaker.retryAfterSeconds(59_999)).toBe(1);
    expect(breaker.retryAfterSeconds(60_000)).toBe(1);
  });
});
