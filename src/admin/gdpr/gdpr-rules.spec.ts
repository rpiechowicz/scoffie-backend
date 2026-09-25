import { gdprAlerts, planAlerts } from '../alerts/alert-rules';
import {
  gdprDaysLeft,
  gdprDueAt,
  gdprExtendedDueAt,
  gdprUrgency,
  isGdprOpen,
} from './gdpr-rules';

const DAY = 24 * 60 * 60_000;
const now = new Date('2026-09-25T12:00:00Z');
const at = (days: number) => new Date(now.getTime() + days * DAY);

describe('terminy RODO', () => {
  it('30 dni od wpływu, po przedłużeniu 90', () => {
    const received = new Date('2026-09-01T08:00:00Z');
    expect(gdprDueAt(received).toISOString()).toBe('2026-10-01T08:00:00.000Z');
    expect(gdprExtendedDueAt(received).toISOString()).toBe(
      '2026-11-30T08:00:00.000Z',
    );
  });

  it('pilność: ok, < 7 dni, po terminie', () => {
    expect(gdprUrgency(at(8), now)).toBe('ok');
    expect(gdprUrgency(at(7), now)).toBe('ok');
    expect(gdprUrgency(at(6.9), now)).toBe('due-soon');
    expect(gdprUrgency(at(0), now)).toBe('due-soon');
    expect(gdprUrgency(at(-0.01), now)).toBe('overdue');
    expect(gdprDaysLeft(at(2.5), now)).toBe(3);
    expect(gdprDaysLeft(at(-1.5), now)).toBe(-2);
  });

  it('otwarte = OPEN i IN_PROGRESS', () => {
    expect(isGdprOpen('OPEN')).toBe(true);
    expect(isGdprOpen('IN_PROGRESS')).toBe(true);
    expect(isGdprOpen('DONE')).toBe(false);
    expect(isGdprOpen('REJECTED')).toBe(false);
  });
});

describe('alert: termin wniosku RODO', () => {
  const id = 'aaaaaaaa-1111-4111-8111-111111111111';

  it('daleko od terminu — cisza; < 7 dni — warning; po terminie — critical', () => {
    expect(gdprAlerts([{ id, kind: 'ACCESS', dueAt: at(10) }], now)).toEqual(
      [],
    );
    const soon = gdprAlerts([{ id, kind: 'ACCESS', dueAt: at(3) }], now);
    expect(soon).toEqual([
      expect.objectContaining({
        key: `gdpr-due:${id}`,
        kind: 'gdpr-due',
        severity: 'warning',
      }),
    ]);
    expect(soon[0].detail).toContain('za 3 dni');
    const late = gdprAlerts([{ id, kind: 'ERASURE', dueAt: at(-2) }], now);
    expect(late[0]).toMatchObject({ severity: 'critical' });
    expect(late[0].detail).toContain('usunięcie (art. 17)');
    expect(late[0].detail).toContain('2 dni temu');
  });

  it('bez adresu wnioskodawcy w treści (idzie mailem i webhookiem)', () => {
    const [alert] = gdprAlerts([{ id, kind: 'ACCESS', dueAt: at(1) }], now);
    expect(`${alert.title} ${alert.detail}`).not.toMatch(/@/);
    expect(alert.detail).toContain(id.slice(0, 8));
  });

  it('ten sam klucz: przejście za termin podbija wagę (touch), zamknięcie wniosku zamyka alert', () => {
    const stored = [
      { id: 'row', key: `gdpr-due:${id}`, kind: 'gdpr-due', resolvedAt: null },
    ];
    const escalated = planAlerts(stored, [
      {
        kind: 'gdpr-due',
        problems: gdprAlerts([{ id, kind: 'ACCESS', dueAt: at(-1) }], now),
      },
    ]);
    expect(escalated.open).toHaveLength(0);
    expect(escalated.touch[0].alert.severity).toBe('critical');

    const closed = planAlerts(stored, [
      { kind: 'gdpr-due', problems: gdprAlerts([], now) },
    ]);
    expect(closed.resolve).toEqual(stored);
  });
});
