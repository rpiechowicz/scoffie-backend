import { Logger } from '@nestjs/common';
import { AppException } from './app-exception';
import {
  actorId,
  householdRoom,
  LEGACY_ROOM,
  setWsAuthObserver,
  userRoom,
} from './ws-socket';

const client = (data: Record<string, unknown>) => ({ data }) as never;

describe('actorId', () => {
  const observer = { onLegacyAct: jest.fn(), onPayloadMismatch: jest.fn() };

  beforeEach(() => {
    observer.onLegacyAct.mockClear();
    observer.onPayloadMismatch.mockClear();
    setWsAuthObserver(observer);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    setWsAuthObserver(null);
    jest.restoreAllMocks();
  });

  it('socket z tokenem → userId z socketu, payload bez userId', () => {
    expect(actorId(client({ userId: 'u1', mode: 'token' }), {})).toBe('u1');
    expect(observer.onPayloadMismatch).not.toHaveBeenCalled();
  });

  it('socket z tokenem → payloadowe userId ignorowane, rozjazd policzony', () => {
    expect(
      actorId(client({ userId: 'victim', mode: 'token' }), {
        userId: 'attacker',
      }),
    ).toBe('victim');
    expect(observer.onPayloadMismatch).toHaveBeenCalledTimes(1);
    expect(observer.onLegacyAct).not.toHaveBeenCalled();
  });

  it('socket z tokenem → to samo userId w payloadzie nie jest rozjazdem', () => {
    expect(
      actorId(client({ userId: 'u1', mode: 'token' }), { userId: 'u1' }),
    ).toBe('u1');
    expect(observer.onPayloadMismatch).not.toHaveBeenCalled();
  });

  it('socket legacy → userId z payloadu, policzone jako legacy', () => {
    expect(actorId(client({ mode: 'legacy' }), { userId: ' old ' })).toBe(
      'old',
    );
    expect(observer.onLegacyAct).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['anonimowy socket z userId w payloadzie', {}, { userId: 'attacker' }],
    ['socket legacy bez userId', { mode: 'legacy' }, {}],
    ['socket legacy z pustym userId', { mode: 'legacy' }, { userId: '  ' }],
    ['socket legacy z nie-stringiem', { mode: 'legacy' }, { userId: 42 }],
    ['brak socketu', undefined, { userId: 'attacker' }],
  ])('%s → UNAUTHORIZED 401', (_label, data, payload) => {
    let thrown: unknown;
    try {
      actorId(data === undefined ? undefined : client(data), payload as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppException);
    expect((thrown as AppException).code).toBe('UNAUTHORIZED');
    expect((thrown as AppException).getStatus()).toBe(401);
    expect(observer.onLegacyAct).not.toHaveBeenCalled();
  });

  it('bez obserwatora nie wybucha', () => {
    setWsAuthObserver(null);
    expect(
      actorId(client({ userId: 'u1', mode: 'token' }), { userId: 'x' }),
    ).toBe('u1');
  });
});

describe('nazwy pokoi', () => {
  it('są stabilnym kontraktem między adapterem a broadcastami', () => {
    expect(userRoom('u1')).toBe('user:u1');
    expect(householdRoom('h1')).toBe('household:h1');
    expect(LEGACY_ROOM).toBe('legacy');
  });
});
