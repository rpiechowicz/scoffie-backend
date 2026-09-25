import {
  announcementMatches,
  charCount,
  clientPlatform,
  compareAnnouncements,
  plainTextProblem,
  type AnnouncementTarget,
} from './announcements.rules';

const NOW = new Date('2026-09-25T12:00:00Z');
const HOME = '2f1c7f4e-8a55-4c61-9d0b-0c7f6f2d9e11';
const OTHER = '9b0e0f8e-2d7a-4a4e-8d1a-3f5e5c1c2b33';
const row = (over: Partial<AnnouncementTarget> = {}): AnnouncementTarget => ({
  audience: 'all',
  householdIds: [],
  startsAt: new Date('2026-09-25T10:00:00Z'),
  endsAt: null,
  ...over,
});

describe('komunikaty — reguły', () => {
  it('platforma: jawny nagłówek, potem User-Agent', () => {
    expect(clientPlatform('ios', 'okhttp/4.12')).toBe('ios');
    expect(clientPlatform('ANDROID', undefined)).toBe('android');
    expect(
      clientPlatform(
        undefined,
        'Scoffie/35 CFNetwork/1568.100.1 Darwin/24.0.0',
      ),
    ).toBe('ios');
    expect(clientPlatform(undefined, 'okhttp/4.12.0')).toBe('android');
    expect(clientPlatform('windows', 'curl/8.0')).toBeNull();
    expect(clientPlatform(undefined, undefined)).toBeNull();
  });

  it('okno czasowe', () => {
    const viewer = { householdId: HOME, platform: 'ios' as const };
    expect(announcementMatches(row(), viewer, NOW)).toBe(true);
    expect(
      announcementMatches(
        row({ startsAt: new Date('2026-09-26T00:00:00Z') }),
        viewer,
        NOW,
      ),
    ).toBe(false);
    expect(announcementMatches(row({ endsAt: NOW }), viewer, NOW)).toBe(false);
  });

  it('odbiorcy: platforma i lista domów, bez cudzych', () => {
    const ios = { householdId: HOME, platform: 'ios' as const };
    const unknown = { householdId: HOME, platform: null };
    expect(announcementMatches(row({ audience: 'ios' }), ios, NOW)).toBe(true);
    expect(announcementMatches(row({ audience: 'android' }), ios, NOW)).toBe(
      false,
    );
    expect(announcementMatches(row({ audience: 'ios' }), unknown, NOW)).toBe(
      false,
    );
    const mine = row({ audience: 'households', householdIds: [HOME] });
    const theirs = row({ audience: 'households', householdIds: [OTHER] });
    expect(announcementMatches(mine, ios, NOW)).toBe(true);
    expect(announcementMatches(theirs, ios, NOW)).toBe(false);
    expect(
      announcementMatches(mine, { householdId: null, platform: 'ios' }, NOW),
    ).toBe(false);
  });

  it('czysty tekst', () => {
    expect(
      plainTextProblem('Przerwa o 22:00 → 23:00 (2 < 3), 5 > 4', false),
    ).toBeNull();
    expect(plainTextProblem('<b>Uwaga</b>', false)).not.toBeNull();
    expect(plainTextProblem('a <script>x</script>', true)).not.toBeNull();
    expect(plainTextProblem('Tom &amp; Jerry', true)).not.toBeNull();
    expect(plainTextProblem('linia\ndruga', true)).toBeNull();
    expect(plainTextProblem('linia\ndruga', false)).not.toBeNull();
  });

  it('znaki liczone jak człowiek (emoji = 1)', () => {
    expect(charCount('🍝🍝')).toBe(2);
  });

  it('krytyczne pierwsze, potem najnowsze', () => {
    const list = [
      { severity: 'info' as const, startsAt: new Date(3) },
      { severity: 'critical' as const, startsAt: new Date(1) },
      { severity: 'warning' as const, startsAt: new Date(2) },
      { severity: 'info' as const, startsAt: new Date(4) },
    ].sort(compareAnnouncements);
    expect(list.map((a) => `${a.severity}${a.startsAt.getTime()}`)).toEqual([
      'critical1',
      'warning2',
      'info4',
      'info3',
    ]);
  });
});
