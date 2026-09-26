import { Logger } from '@nestjs/common';
import {
  activityDayKey,
  LAST_SEEN_EVERY_MS,
  UserActivityService,
} from './user-activity.service';

const flush = () => new Promise((resolve) => setImmediate(resolve));

const make = (executeRaw: jest.Mock = jest.fn().mockResolvedValue(1)) => ({
  service: new UserActivityService({ $executeRaw: executeRaw } as never),
  executeRaw,
});

type Call = unknown[];
const sqlOf = (call: Call) => (call[0] as readonly string[]).join('?');
/** Zapisy doby (`UserActivityDay`). */
const dayCalls = (executeRaw: jest.Mock): Call[] =>
  (executeRaw.mock.calls as Call[]).filter((c) =>
    sqlOf(c).includes('UserActivityDay'),
  );
/** Zapisy „ostatnio w aplikacji” (`User.lastSeenAt`). */
const seenCalls = (executeRaw: jest.Mock): Call[] =>
  (executeRaw.mock.calls as Call[]).filter((c) =>
    sqlOf(c).includes('lastSeenAt'),
  );

/** Dzień zapisany w wywołaniu `$executeRaw` (drugi parametr szablonu). */
const writtenDay = (executeRaw: jest.Mock, call: number): unknown =>
  dayCalls(executeRaw)[call][2];
/** Osoba i chwila zapisana w `lastSeenAt` (parametry: chwila, osoba, chwila). */
const writtenSeen = (executeRaw: jest.Mock, call: number) => {
  const c = seenCalls(executeRaw)[call];
  return { at: c[1], userId: c[2] };
};

describe('activityDayKey', () => {
  it('doba warszawska, nie UTC (0:30 w Polsce to jeszcze wczoraj w UTC)', () => {
    expect(activityDayKey(new Date('2026-09-24T22:30:00Z'))).toBe('2026-09-25');
    expect(activityDayKey(new Date('2026-09-24T21:59:59Z'))).toBe('2026-09-24');
    // Zima (UTC+1): północ w Polsce o 23:00 UTC.
    expect(activityDayKey(new Date('2026-12-31T23:00:00Z'))).toBe('2027-01-01');
  });
});

describe('UserActivityService.record — doba', () => {
  afterEach(() => jest.restoreAllMocks());

  it('jeden zapis na osobę i dobę — kolejne żądania nie dotykają bazy', async () => {
    const { service, executeRaw } = make();
    const now = new Date('2026-09-25T08:00:00Z');

    service.record('u1', now);
    service.record('u1', new Date('2026-09-25T20:00:00Z'));
    service.record('u2', now);
    await flush();

    expect(dayCalls(executeRaw)).toHaveLength(2);
    expect(writtenDay(executeRaw, 0)).toBe('2026-09-25');
  });

  it('po północy (Warszawa) ta sama osoba zapisuje się znowu', async () => {
    const { service, executeRaw } = make();

    service.record('u1', new Date('2026-09-25T21:00:00Z'));
    service.record('u1', new Date('2026-09-25T22:30:00Z'));
    await flush();

    expect(dayCalls(executeRaw)).toHaveLength(2);
    expect(writtenDay(executeRaw, 0)).toBe('2026-09-25');
    expect(writtenDay(executeRaw, 1)).toBe('2026-09-26');
  });

  it('błąd zapisu doby: tylko log, bez wyjątku; następne żądanie próbuje ponownie', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const executeRaw = jest.fn((sql: readonly string[]) =>
      sql.join('?').includes('UserActivityDay') &&
      dayCalls(executeRaw).length === 1
        ? Promise.reject(new Error('baza leży'))
        : Promise.resolve(1),
    );
    const { service } = make(executeRaw);
    const now = new Date('2026-09-25T08:00:00Z');

    expect(() => service.record('u1', now)).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);

    service.record('u1', now);
    await flush();
    service.record('u1', now);
    await flush();
    expect(dayCalls(executeRaw)).toHaveLength(2);
  });
});

describe('UserActivityService.record — ostatnio w aplikacji', () => {
  afterEach(() => jest.restoreAllMocks());

  it('pierwsze żądanie zapisuje lastSeenAt z chwilą żądania', async () => {
    const { service, executeRaw } = make();
    const now = new Date('2026-09-26T12:34:56.000Z');

    service.record('u1', now);
    await flush();

    expect(seenCalls(executeRaw)).toHaveLength(1);
    expect(writtenSeen(executeRaw, 0)).toEqual({
      at: '2026-09-26T12:34:56.000Z',
      userId: 'u1',
    });
  });

  it('najwyżej raz na 5 minut na osobę; inne osoby osobno', async () => {
    const { service, executeRaw } = make();
    const t0 = new Date('2026-09-26T12:00:00Z').getTime();

    service.record('u1', new Date(t0));
    service.record('u1', new Date(t0 + 60_000));
    service.record('u1', new Date(t0 + LAST_SEEN_EVERY_MS - 1));
    service.record('u2', new Date(t0 + 60_000));
    await flush();
    expect(seenCalls(executeRaw)).toHaveLength(2);

    service.record('u1', new Date(t0 + LAST_SEEN_EVERY_MS));
    await flush();
    expect(seenCalls(executeRaw)).toHaveLength(3);
    expect(writtenSeen(executeRaw, 2)).toEqual({
      at: new Date(t0 + LAST_SEEN_EVERY_MS).toISOString(),
      userId: 'u1',
    });
  });

  it('nowa doba nie zeruje okna 5 minut (lastSeenAt nie zależy od doby)', async () => {
    const { service, executeRaw } = make();

    service.record('u1', new Date('2026-09-25T21:59:00Z'));
    service.record('u1', new Date('2026-09-25T22:01:00Z')); // północ w Warszawie
    await flush();

    expect(dayCalls(executeRaw)).toHaveLength(2);
    expect(seenCalls(executeRaw)).toHaveLength(1);
  });

  it('błąd zapisu lastSeenAt: tylko log; następne żądanie próbuje od razu', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const executeRaw = jest.fn((sql: readonly string[]) =>
      sql.join('?').includes('lastSeenAt') && seenCalls(executeRaw).length === 1
        ? Promise.reject(new Error('baza leży'))
        : Promise.resolve(1),
    );
    const { service } = make(executeRaw);
    const t0 = new Date('2026-09-26T12:00:00Z').getTime();

    expect(() => service.record('u1', new Date(t0))).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);

    service.record('u1', new Date(t0 + 1_000));
    await flush();
    expect(seenCalls(executeRaw)).toHaveLength(2);
  });

  it('zapis nie cofa wartości: warunek „starsze niż ta chwila” w UPDATE', () => {
    const { service, executeRaw } = make();
    service.record('u1', new Date('2026-09-26T12:00:00Z'));
    const sql = sqlOf(seenCalls(executeRaw)[0]);
    expect(sql).toContain('"lastSeenAt" IS NULL');
    expect(sql).toContain('"lastSeenAt" <');
    expect(sql).not.toContain('updatedAt');
  });
});
