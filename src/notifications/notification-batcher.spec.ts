import { NotificationBatcher } from './notification-batcher';

/**
 * Cały sens tej klasy to „ile powiadomień wyjdzie", a nie „co w nich jest".
 * Testy mierzą więc liczbę wysyłek przy zadanym strumieniu zdarzeń — bo to
 * dokładnie ta liczba była problemem: jedna sesja układania planu wysyłała
 * tyle pushy, ile kratek zostało tkniętych.
 */
describe('NotificationBatcher', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const makeBatcher = (
    onFlush: (key: string, events: number[]) => Promise<void>,
    deferralMs = 0,
  ) =>
    new NotificationBatcher<number>(
      { windowMs: 1000, maxWaitMs: 5000 },
      onFlush,
      () => Promise.resolve(deferralMs),
    );

  it('zwija serię zdarzeń w jedną wysyłkę', async () => {
    const flushes: number[][] = [];
    const batcher = makeBatcher((_key, events) => {
      flushes.push(events);
      return Promise.resolve();
    });

    for (let i = 0; i < 20; i += 1) {
      batcher.enqueue('household-1', i);
      jest.advanceTimersByTime(200); // szybciej niż okno ciszy
    }

    expect(flushes).toHaveLength(0);

    jest.advanceTimersByTime(1000);
    await Promise.resolve();

    expect(flushes).toHaveLength(1);
    expect(flushes[0]).toHaveLength(20);
  });

  it('okno jest przesuwne — cisza, a nie stały interwał, kończy paczkę', async () => {
    const flushes: number[][] = [];
    const batcher = makeBatcher((_key, events) => {
      flushes.push(events);
      return Promise.resolve();
    });

    batcher.enqueue('household-1', 1);
    jest.advanceTimersByTime(900);
    batcher.enqueue('household-1', 2);
    jest.advanceTimersByTime(900);
    expect(flushes).toHaveLength(0);

    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(flushes).toEqual([[1, 2]]);
  });

  it('sufit wypuszcza paczkę mimo trwającej aktywności', async () => {
    const flushes: number[][] = [];
    const batcher = makeBatcher((_key, events) => {
      flushes.push(events);
      return Promise.resolve();
    });

    // Zdarzenie co 500 ms bez końca: samo okno ciszy nigdy by nie minęło.
    for (let i = 0; i < 12; i += 1) {
      batcher.enqueue('household-1', i);
      jest.advanceTimersByTime(500);
    }
    await Promise.resolve();

    expect(flushes.length).toBeGreaterThanOrEqual(1);
    expect(flushes[0].length).toBeGreaterThan(1);
  });

  it('różne klucze zbierają się osobno', async () => {
    const flushed: Record<string, number[]> = {};
    const batcher = makeBatcher((key, events) => {
      flushed[key] = events;
      return Promise.resolve();
    });

    batcher.enqueue('household-1', 1);
    batcher.enqueue('household-2', 2);
    jest.advanceTimersByTime(1000);
    await Promise.resolve();

    expect(flushed).toEqual({ 'household-1': [1], 'household-2': [2] });
  });

  it('odroczenie (cisza nocna) przesuwa wysyłkę, nie kasuje paczki', async () => {
    const flushes: number[][] = [];
    let deferralMs = 3000;
    const batcher = new NotificationBatcher<number>(
      { windowMs: 1000, maxWaitMs: 5000 },
      (_key, events) => {
        flushes.push(events);
        return Promise.resolve();
      },
      () => Promise.resolve(deferralMs),
    );

    batcher.enqueue('household-1', 1);
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(flushes).toHaveLength(0);

    // „Rano": kolejna próba wysyłki już nie odracza.
    deferralMs = 0;
    jest.advanceTimersByTime(3000);
    await Promise.resolve();
    await Promise.resolve();

    expect(flushes).toEqual([[1]]);
  });

  it('dispose porzuca oczekujące paczki bez wysyłki', async () => {
    const onFlush = jest.fn().mockResolvedValue(undefined);
    const batcher = makeBatcher(onFlush);

    batcher.enqueue('household-1', 1);
    expect(batcher.pendingCount).toBe(1);

    batcher.dispose();
    jest.advanceTimersByTime(10_000);
    await Promise.resolve();

    expect(onFlush).not.toHaveBeenCalled();
    expect(batcher.pendingCount).toBe(0);
  });
});
