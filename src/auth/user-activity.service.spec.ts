import { Logger } from '@nestjs/common';
import { activityDayKey, UserActivityService } from './user-activity.service';

const flush = () => new Promise((resolve) => setImmediate(resolve));

const make = (executeRaw: jest.Mock = jest.fn().mockResolvedValue(1)) => ({
  service: new UserActivityService({ $executeRaw: executeRaw } as never),
  executeRaw,
});

/** Dzień zapisany w wywołaniu `$executeRaw` (drugi parametr szablonu). */
const writtenDay = (executeRaw: jest.Mock, call: number): unknown =>
  (executeRaw.mock.calls[call] as unknown[])[2];

describe('activityDayKey', () => {
  it('doba warszawska, nie UTC (0:30 w Polsce to jeszcze wczoraj w UTC)', () => {
    expect(activityDayKey(new Date('2026-09-24T22:30:00Z'))).toBe('2026-09-25');
    expect(activityDayKey(new Date('2026-09-24T21:59:59Z'))).toBe('2026-09-24');
    // Zima (UTC+1): północ w Polsce o 23:00 UTC.
    expect(activityDayKey(new Date('2026-12-31T23:00:00Z'))).toBe('2027-01-01');
  });
});

describe('UserActivityService.record', () => {
  afterEach(() => jest.restoreAllMocks());

  it('jeden zapis na osobę i dobę — kolejne żądania nie dotykają bazy', async () => {
    const { service, executeRaw } = make();
    const now = new Date('2026-09-25T08:00:00Z');

    service.record('u1', now);
    service.record('u1', new Date('2026-09-25T20:00:00Z'));
    service.record('u2', now);
    await flush();

    expect(executeRaw).toHaveBeenCalledTimes(2);
    expect(writtenDay(executeRaw, 0)).toBe('2026-09-25');
  });

  it('po północy (Warszawa) ta sama osoba zapisuje się znowu', async () => {
    const { service, executeRaw } = make();

    service.record('u1', new Date('2026-09-25T21:00:00Z'));
    service.record('u1', new Date('2026-09-25T22:30:00Z'));
    await flush();

    expect(executeRaw).toHaveBeenCalledTimes(2);
    expect(writtenDay(executeRaw, 0)).toBe('2026-09-25');
    expect(writtenDay(executeRaw, 1)).toBe('2026-09-26');
  });

  it('błąd zapisu: tylko log, bez wyjątku; następne żądanie próbuje ponownie', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const executeRaw = jest
      .fn()
      .mockRejectedValueOnce(new Error('baza leży'))
      .mockResolvedValue(1);
    const { service } = make(executeRaw);
    const now = new Date('2026-09-25T08:00:00Z');

    expect(() => service.record('u1', now)).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);

    service.record('u1', now);
    await flush();
    service.record('u1', now);
    await flush();
    expect(executeRaw).toHaveBeenCalledTimes(2);
  });
});
