import { LIVE_TOPICS } from '../../common/live-events';
import { ADMIN_ROLE_PERMISSIONS } from '../admin-permissions';
import { auditLiveTopics } from '../audit/admin-audit.service';
import { RailwayLogTail } from '../integrations/railway-service.client';
import {
  InvalidateBatcher,
  LIVE_CLIENT_MAX_BYTES,
  parseClientMessage,
  topicAllowed,
  topicsForRole,
} from './live-protocol';

describe('kanał na żywo — uprawnienia tematów', () => {
  const roles = ADMIN_ROLE_PERMISSIONS as Record<string, readonly string[]>;
  afterEach(() => {
    delete roles.SUPPORT_TEST;
  });

  it('OWNER widzi wszystkie tematy', () => {
    expect(topicsForRole('OWNER')).toEqual([...LIVE_TOPICS]);
  });

  it('nieznana rola widzi tylko własne sesje panelu', () => {
    expect(topicsForRole('NOBODY')).toEqual(['admin-sessions']);
    expect(topicAllowed('NOBODY', 'users')).toBe(false);
  });

  it('rola bez pieniędzy i poczty nie dostaje ich tematów', () => {
    roles.SUPPORT_TEST = ['users.read', 'assistant.read', 'flags.read'];
    const topics = topicsForRole('SUPPORT_TEST');
    expect(topics).toEqual(
      expect.arrayContaining(['users', 'assistant', 'reports', 'settings']),
    );
    expect(topics).not.toContain('subscriptions');
    expect(topics).not.toContain('mail');
    expect(topics).not.toContain('audit');
  });
});

describe('kanał na żywo — walidacja wiadomości klienta', () => {
  it('ping', () => {
    expect(parseClientMessage('{"type":"ping"}')).toEqual({
      ok: true,
      message: { type: 'ping' },
    });
  });

  it('logs.subscribe — poprawna, bez deploymentId i z nim', () => {
    const ok = parseClientMessage(
      JSON.stringify({
        type: 'logs.subscribe',
        subscriptionId: 'a-1',
        serviceId: 'c0ffee00-0000-4000-8000-000000000001',
        kind: 'deploy',
      }),
    );
    expect(ok.ok).toBe(true);
    const withDeploy = parseClientMessage(
      JSON.stringify({
        type: 'logs.subscribe',
        subscriptionId: 'a_2',
        serviceId: 'svc',
        deploymentId: 'dep-1',
        kind: 'build',
      }),
    );
    expect(withDeploy).toEqual({
      ok: true,
      message: {
        type: 'logs.subscribe',
        subscriptionId: 'a_2',
        serviceId: 'svc',
        deploymentId: 'dep-1',
        kind: 'build',
      },
    });
  });

  it.each([
    ['nie JSON', 'hej'],
    ['tablica', '[]'],
    ['bez type', '{}'],
    ['nieznany typ', '{"type":"subscribe"}'],
    ['nadmiarowe pole', '{"type":"ping","x":1}'],
    [
      'zły kind',
      '{"type":"logs.subscribe","subscriptionId":"a","serviceId":"s","kind":"all"}',
    ],
    [
      'zły serviceId',
      '{"type":"logs.subscribe","subscriptionId":"a","serviceId":"../x","kind":"deploy"}',
    ],
    ['zły subscriptionId', '{"type":"logs.unsubscribe","subscriptionId":""}'],
  ])('odrzuca: %s', (_label, raw) => {
    expect(parseClientMessage(raw)).toMatchObject({
      ok: false,
      code: 'BAD_MESSAGE',
    });
  });

  it('ramka binarna i za duża ramka', () => {
    expect(
      parseClientMessage(Buffer.from('{"type":"ping"}'), true),
    ).toMatchObject({ ok: false, code: 'BAD_MESSAGE' });
    const big = JSON.stringify({
      type: 'ping',
      pad: 'x'.repeat(LIVE_CLIENT_MAX_BYTES),
    });
    expect(parseClientMessage(big)).toMatchObject({
      ok: false,
      code: 'TOO_LARGE',
    });
  });
});

describe('kanał na żywo — łączenie invalidate', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('seria zdarzeń w oknie = jedna wiadomość z sumą tematów, w stałej kolejności', () => {
    const flush = jest.fn();
    const batcher = new InvalidateBatcher(flush, 1_000);
    batcher.add(['mail']);
    jest.advanceTimersByTime(300);
    batcher.add(['users', 'mail']);
    batcher.add(['dashboard']);
    expect(flush).not.toHaveBeenCalled();
    jest.advanceTimersByTime(700);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(['dashboard', 'users', 'mail']);
    batcher.add(['audit']);
    jest.advanceTimersByTime(1_000);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenLastCalledWith(['audit']);
  });

  it('puste tematy nie otwierają okna; dispose kasuje oczekujące', () => {
    const flush = jest.fn();
    const batcher = new InvalidateBatcher(flush, 1_000);
    batcher.add([]);
    jest.advanceTimersByTime(2_000);
    expect(flush).not.toHaveBeenCalled();
    batcher.add(['ops']);
    batcher.dispose();
    jest.advanceTimersByTime(2_000);
    expect(flush).not.toHaveBeenCalled();
  });
});

describe('kanał na żywo — deduplikacja logów Railway', () => {
  const line = (timestamp: string, message: string) => ({
    timestamp,
    severity: 'info',
    message,
  });

  it('pobrania na zakładkę dają tylko nowe linie, rosnąco', () => {
    const tail = new RailwayLogTail();
    expect(
      tail.accept([
        line('2026-09-25T10:00:01.000Z', 'a'),
        line('2026-09-25T10:00:02.000Z', 'b'),
      ]),
    ).toHaveLength(2);
    const fresh = tail.accept([
      line('2026-09-25T10:00:02.000Z', 'b'),
      line('2026-09-25T10:00:03.000Z', 'd'),
      line('2026-09-25T10:00:02.000Z', 'c'),
    ]);
    expect(fresh.map((l) => l.message)).toEqual(['c', 'd']);
    expect(tail.latest).toBe(Date.parse('2026-09-25T10:00:03.000Z'));
  });

  it('pamięć ograniczona — najstarsze klucze wypadają', () => {
    const tail = new RailwayLogTail(2);
    tail.accept([line('t1', 'a'), line('t2', 'b'), line('t3', 'c')]);
    expect(tail.accept([line('t1', 'a')])).toHaveLength(1);
    expect(tail.accept([line('t3', 'c')])).toHaveLength(0);
  });
});

describe('kanał na żywo — tematy z akcji audytu', () => {
  it.each([
    ['settings.set', ['settings']],
    ['flags.household.set', ['settings']],
    ['announcements.create', ['settings']],
    ['gdpr.close', ['gdpr']],
    ['mail.suppression.add', ['mail']],
    ['alert.ack', ['alerts']],
    ['report.status.set', ['reports']],
    ['auth.session.revoke', ['admin-sessions']],
    ['user.delete', ['users', 'households', 'dashboard']],
    ['coś.nowego', []],
  ])('%s', (action, topics) => {
    expect(auditLiveTopics(action)).toEqual(topics);
  });
});
