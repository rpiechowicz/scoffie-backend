import { LiveEvents, type LiveEvent } from './live-events';

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('LiveEvents (szyna kanału na żywo)', () => {
  it('bez słuchaczy nic nie robi i nie rzuca', () => {
    const bus = new LiveEvents();
    expect(() => bus.emit({ topics: ['users'] })).not.toThrow();
  });

  it('dostarcza PO bieżącym wywołaniu (setImmediate), nie synchronicznie', async () => {
    const bus = new LiveEvents();
    const seen: LiveEvent[] = [];
    bus.on((event) => seen.push(event));
    bus.emit({ topics: ['users', 'dashboard'] });
    expect(seen).toHaveLength(0);
    await flush();
    expect(seen).toEqual([{ topics: ['users', 'dashboard'] }]);
  });

  it('wyjątek słuchacza nie wychodzi do wołającego ani nie blokuje innych', async () => {
    const bus = new LiveEvents();
    const second = jest.fn();
    bus.on(() => {
      throw new Error('boom');
    });
    bus.on(second);
    expect(() => bus.emit({ topics: ['mail'] })).not.toThrow();
    await flush();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('odsiewa nieznane tematy i duplikaty; puste zdarzenie ginie', async () => {
    const bus = new LiveEvents();
    const seen: LiveEvent[] = [];
    bus.on((event) => seen.push(event));
    bus.emit({ topics: ['mail', 'mail', 'nope' as never] });
    bus.emit({ topics: ['nope' as never] });
    await flush();
    expect(seen).toEqual([{ topics: ['mail'] }]);
  });

  it('przycina tytuł i treść powiadomienia', async () => {
    const bus = new LiveEvents();
    const seen: LiveEvent[] = [];
    bus.on((event) => seen.push(event));
    bus.emit({
      topics: [],
      notice: { level: 'info', title: 'x'.repeat(500), body: 'y'.repeat(900) },
    });
    await flush();
    expect(seen[0].notice?.title).toHaveLength(120);
    expect(seen[0].notice?.body).toHaveLength(300);
  });

  it('odwołanie sesji bez tematów też przechodzi; wyrejestrowanie działa', async () => {
    const bus = new LiveEvents();
    const listener = jest.fn();
    const off = bus.on(listener);
    bus.emit({ topics: [], revokedAdminSessionId: 's1' });
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    bus.emit({ topics: ['users'] });
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(bus.listenerCount).toBe(0);
  });
});
