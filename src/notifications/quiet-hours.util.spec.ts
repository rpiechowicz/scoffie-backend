import { quietHoursDeferralMs } from './quiet-hours.util';

/**
 * Okno przechodzi przez północ, więc naiwne `start <= t && t < end` daje tu
 * zawsze `false` i cisza nocna po cichu przestaje działać. Testy trzymają obie
 * połowy okna oraz to, że odroczenie CELUJE w koniec ciszy — powiadomienie ma
 * dojechać rano, a nie zniknąć.
 */
describe('quietHoursDeferralMs', () => {
  const WARSAW = 'Europe/Warsaw';

  // Sierpień = czas letni w Polsce (UTC+2).
  const utc = (hour: number, minute = 0) =>
    new Date(Date.UTC(2026, 7, 24, hour, minute));

  it('nie odracza w środku dnia', () => {
    expect(quietHoursDeferralMs(utc(12), WARSAW)).toBe(0); // 14:00 lokalnie
  });

  it('odracza tuż po 22:00 lokalnego czasu', () => {
    // 20:05 UTC = 22:05 w Warszawie → do 7:00 zostaje 8 h 55 min.
    expect(quietHoursDeferralMs(utc(20, 5), WARSAW)).toBe(
      (8 * 60 + 55) * 60 * 1000,
    );
  });

  it('odracza nad ranem, przed końcem okna', () => {
    // 04:30 UTC = 06:30 w Warszawie → 30 minut do 7:00.
    expect(quietHoursDeferralMs(utc(4, 30), WARSAW)).toBe(30 * 60 * 1000);
  });

  it('przepuszcza dokładnie o 7:00', () => {
    expect(quietHoursDeferralMs(utc(5), WARSAW)).toBe(0); // 07:00 lokalnie
  });

  it('liczy w strefie użytkownika, nie kontenera', () => {
    // Ta sama chwila: w Warszawie 14:00 (dzień), w Auckland 02:00 (noc).
    const moment = utc(12);
    expect(quietHoursDeferralMs(moment, WARSAW)).toBe(0);
    expect(quietHoursDeferralMs(moment, 'Pacific/Auckland')).toBeGreaterThan(0);
  });

  it('nieznana strefa nie wywraca wysyłki — liczy po polsku', () => {
    expect(quietHoursDeferralMs(utc(12), 'Nie/Ma/Takiej')).toBe(0);
    expect(quietHoursDeferralMs(utc(12), null)).toBe(0);
  });
});
