import {
  broadcastToHousehold,
  disconnectUser,
  joinHousehold,
  leaveHousehold,
} from './ws-rooms';

const makeServer = () => {
  const emit = jest.fn();
  const socketsJoin = jest.fn();
  const socketsLeave = jest.fn();
  const disconnectSockets = jest.fn();
  const to = jest.fn().mockReturnValue({ emit });
  const inRoom = jest.fn().mockReturnValue({
    socketsJoin,
    socketsLeave,
    disconnectSockets,
  });
  return {
    server: { to, in: inRoom } as never,
    emit,
    to,
    inRoom,
    socketsJoin,
    socketsLeave,
    disconnectSockets,
  };
};

describe('ws-rooms', () => {
  it('broadcastToHousehold: pokój gospodarstwa + legacy, nigdy globalnie', () => {
    const s = makeServer();
    broadcastToHousehold(s.server, 'hh-1', 'weeklyPlans:weekChanged', {
      householdId: 'hh-1',
    });
    expect(s.to).toHaveBeenCalledWith(['household:hh-1', 'legacy']);
    expect(s.emit).toHaveBeenCalledWith('weeklyPlans:weekChanged', {
      householdId: 'hh-1',
    });
  });

  it('joinHousehold/leaveHousehold działają na wszystkich socketach usera', () => {
    const s = makeServer();
    joinHousehold(s.server, 'u1', 'hh-1');
    leaveHousehold(s.server, 'u1', 'hh-2');
    expect(s.inRoom).toHaveBeenNthCalledWith(1, 'user:u1');
    expect(s.socketsJoin).toHaveBeenCalledWith('household:hh-1');
    expect(s.inRoom).toHaveBeenNthCalledWith(2, 'user:u1');
    expect(s.socketsLeave).toHaveBeenCalledWith('household:hh-2');
  });

  it('disconnectUser zamyka wszystkie sockety usera (close=true)', () => {
    const s = makeServer();
    disconnectUser(s.server, 'u1');
    expect(s.inRoom).toHaveBeenCalledWith('user:u1');
    expect(s.disconnectSockets).toHaveBeenCalledWith(true);
  });

  it('brak serwera (gateway bez @WebSocketServer w teście) nie wybucha', () => {
    expect(() => broadcastToHousehold(undefined, 'hh', 'x', {})).not.toThrow();
    expect(() => joinHousehold(null, 'u', 'hh')).not.toThrow();
    expect(() => disconnectUser(undefined, 'u')).not.toThrow();
  });
});
