import {
  resolveInvitationStatus,
  shouldAddToInbox,
} from './invitation-status.util';

/**
 * Statusy sterują tym, co użytkownik zobaczy i czego mu wolno — a różnią się
 * między sobą jednym faktem naraz. Testy trzymają kolejność sprawdzeń, bo to
 * ona decyduje, który z kilku prawdziwych jednocześnie warunków wygra.
 */
describe('resolveInvitationStatus', () => {
  const NOW = new Date('2026-08-23T12:00:00.000Z');
  const TOMORROW = new Date('2026-08-24T12:00:00.000Z');
  const YESTERDAY = new Date('2026-08-22T12:00:00.000Z');

  const base = {
    redeemedAt: null,
    declinedAt: null,
    expiresAt: TOMORROW,
    isAlreadyMember: false,
    belongsToAnotherHousehold: false,
    now: NOW,
  };

  it('świeże zaproszenie dla kogoś bez gospodarstwa to PENDING', () => {
    expect(resolveInvitationStatus(base)).toBe('PENDING');
  });

  it('świeże zaproszenie dla kogoś, kto ma już dom, to REQUIRES_LEAVE', () => {
    // To jest przypadek z życia: znajomy należał już do gospodarstwa i przez to
    // zaproszenie „nie działało". Nie jest to błąd — to pytanie do niego.
    expect(
      resolveInvitationStatus({ ...base, belongsToAnotherHousehold: true }),
    ).toBe('REQUIRES_LEAVE');
  });

  it('członkostwo w TYM domu wygrywa ze wszystkim', () => {
    expect(
      resolveInvitationStatus({
        ...base,
        isAlreadyMember: true,
        expiresAt: YESTERDAY,
        redeemedAt: NOW,
        belongsToAnotherHousehold: true,
      }),
    ).toBe('ALREADY_MEMBER');
  });

  it('wykorzystane wygrywa z wygaśnięciem', () => {
    expect(
      resolveInvitationStatus({
        ...base,
        redeemedAt: YESTERDAY,
        expiresAt: YESTERDAY,
      }),
    ).toBe('REDEEMED');
  });

  it('odrzucone nie wraca jako PENDING', () => {
    expect(resolveInvitationStatus({ ...base, declinedAt: NOW })).toBe(
      'DECLINED',
    );
  });

  it('odrzucone nie zamienia się w REQUIRES_LEAVE', () => {
    expect(
      resolveInvitationStatus({
        ...base,
        declinedAt: NOW,
        belongsToAnotherHousehold: true,
      }),
    ).toBe('DECLINED');
  });

  it('wygasłe zaproszenie to EXPIRED, nawet gdy nie ma innego domu', () => {
    expect(resolveInvitationStatus({ ...base, expiresAt: YESTERDAY })).toBe(
      'EXPIRED',
    );
  });
});

describe('shouldAddToInbox', () => {
  it('odkłada to, co da się jeszcze przyjąć', () => {
    expect(shouldAddToInbox('PENDING')).toBe(true);
    expect(shouldAddToInbox('REQUIRES_LEAVE')).toBe(true);
  });

  it('nie odkłada stanów zamkniętych', () => {
    // Skrzynka z pozycją, w którą nie da się kliknąć, jest gorsza niż pusta.
    for (const status of [
      'REDEEMED',
      'DECLINED',
      'EXPIRED',
      'ALREADY_MEMBER',
      'NOT_FOUND',
    ] as const) {
      expect(shouldAddToInbox(status)).toBe(false);
    }
  });
});
