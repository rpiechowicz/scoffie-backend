import { Test, TestingModule } from '@nestjs/testing';
import { HouseholdsGateway } from './households.gateway';
import { HouseholdsService } from './households.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WsTelemetryService } from '../common/ws-telemetry.service';

// Gateway ma na własność: tożsamość z socketu (`actorId`), listę domowników
// doklejoną do `households:membersChanged` (albo jej brak, gdy autor jest już
// poza domem), rozgłoszenie planu dla tygodni dotkniętych zmianą składu oraz
// pokoje `household:<id>` (join PRZED emitem, leave PO emicie). Reszta to
// przekazanie wywołania do serwisu.

const HH = 'hh-1';
const USER = 'user-1';
const LEGACY = ['household:' + HH, 'legacy'];

const tokenClient = (userId: string) =>
  ({ data: { userId, mode: 'token' } }) as any;
const legacyClient = () => ({ data: { mode: 'legacy' } }) as any;
const anonClient = () => ({ data: {} }) as any;

describe('HouseholdsGateway', () => {
  let gateway: HouseholdsGateway;
  let emit: jest.Mock;
  let to: jest.Mock;
  let inRoom: jest.Mock;
  let socketsJoin: jest.Mock;
  let socketsLeave: jest.Mock;
  let disconnectSockets: jest.Mock;
  let householdsService: Record<string, jest.Mock>;
  let notificationsService: Record<string, jest.Mock>;

  const emitted = (event: string) =>
    emit.mock.calls.filter(([name]) => name === event).map(([, body]) => body);

  /** Każdy emit poszedł przez `server.to(...)` — zero globalnych emitów. */
  const expectAllEmitsRoomScoped = () =>
    expect(to).toHaveBeenCalledTimes(emit.mock.calls.length);

  const firstCall = (fn: jest.Mock) => fn.mock.invocationCallOrder[0];
  const lastCall = (fn: jest.Mock) =>
    fn.mock.invocationCallOrder[fn.mock.invocationCallOrder.length - 1];

  beforeEach(async () => {
    emit = jest.fn();
    to = jest.fn().mockReturnValue({ emit });
    socketsJoin = jest.fn();
    socketsLeave = jest.fn();
    disconnectSockets = jest.fn();
    inRoom = jest
      .fn()
      .mockReturnValue({ socketsJoin, socketsLeave, disconnectSockets });

    householdsService = {
      getUserDisplayName: jest.fn().mockResolvedValue('Ania'),
      listMembers: jest.fn().mockResolvedValue([{ userId: USER }]),
      findAll: jest.fn().mockResolvedValue([]),
      findById: jest.fn().mockResolvedValue({ id: HH, name: 'Dom' }),
      create: jest.fn().mockResolvedValue({ id: HH, name: 'Dom' }),
      createInvitation: jest.fn().mockResolvedValue({ token: 'tok' }),
      acceptInvitation: jest.fn().mockResolvedValue({
        id: 'm-joined',
        householdId: HH,
        leftHouseholdIds: [],
        touchedWeeks: [],
      }),
      previewInvitation: jest.fn().mockResolvedValue({ addedToInbox: false }),
      listPendingInvitations: jest.fn().mockResolvedValue([]),
      declineInvitation: jest.fn().mockResolvedValue({ success: true }),
      updateName: jest.fn().mockResolvedValue({ id: HH, name: 'Nowy' }),
      updateMealTypes: jest
        .fn()
        .mockResolvedValue({ enabledMealTypes: ['BREAKFAST', 'DINNER'] }),
      updateMealTimes: jest
        .fn()
        .mockResolvedValue({ mealSlotTimes: { BREAKFAST: '08:00' } }),
      updateMemberRole: jest.fn().mockResolvedValue({ id: 'm-1' }),
      removeMember: jest
        .fn()
        .mockResolvedValue({ id: 'm-1', touchedWeekStarts: [] }),
      leave: jest.fn().mockResolvedValue({
        success: true,
        householdDeleted: false,
        touchedWeekStarts: [],
      }),
    };
    notificationsService = {
      notifyHouseholdMembershipChanged: jest.fn().mockResolvedValue(undefined),
      notifyHouseholdInvitation: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HouseholdsGateway,
        { provide: HouseholdsService, useValue: householdsService },
        { provide: NotificationsService, useValue: notificationsService },
        {
          provide: WsTelemetryService,
          useValue: { onConnect: jest.fn(), onDisconnect: jest.fn() },
        },
      ],
    }).compile();

    gateway = module.get<HouseholdsGateway>(HouseholdsGateway);
    (gateway as any).server = { emit, to, in: inRoom };
  });

  describe('tożsamość z socketu (actorId) — każdy handler', () => {
    type Case = {
      event: string;
      invoke: (client: any, payload: any) => Promise<unknown>;
      payload: Record<string, unknown>;
      /** Metoda serwisu, która dostaje userId jako PIERWSZY argument. */
      service: string;
    };

    const cases: Case[] = [
      {
        event: 'households:findAll',
        invoke: (c, p) => gateway.findAll(c, p),
        payload: {},
        service: 'findAll',
      },
      {
        event: 'households:findById',
        invoke: (c, p) => gateway.findById(c, p),
        payload: { id: HH },
        service: 'findById',
      },
      {
        event: 'households:create',
        invoke: (c, p) => gateway.create(c, p),
        payload: { data: { name: 'Dom' } },
        service: 'create',
      },
      {
        event: 'households:createInvitation',
        invoke: (c, p) => gateway.createInvitation(c, p),
        payload: { householdId: HH, data: { email: 'x@y.z' } },
        service: 'createInvitation',
      },
      {
        event: 'households:acceptInvitation',
        invoke: (c, p) => gateway.acceptInvitation(c, p),
        payload: { data: { token: 'tok-12345678' } },
        service: 'acceptInvitation',
      },
      {
        event: 'households:previewInvitation',
        invoke: (c, p) => gateway.previewInvitation(c, p),
        payload: { data: { token: 'tok-12345678' } },
        service: 'previewInvitation',
      },
      {
        event: 'households:listPendingInvitations',
        invoke: (c, p) => gateway.listPendingInvitations(c, p),
        payload: {},
        service: 'listPendingInvitations',
      },
      {
        event: 'households:declineInvitation',
        invoke: (c, p) => gateway.declineInvitation(c, p),
        payload: { data: { token: 'tok-12345678' } },
        service: 'declineInvitation',
      },
      {
        event: 'households:updateName',
        invoke: (c, p) => gateway.updateName(c, p),
        payload: { householdId: HH, data: { name: 'Nowy' } },
        service: 'updateName',
      },
      {
        event: 'households:updateMealTypes',
        invoke: (c, p) => gateway.updateMealTypes(c, p),
        payload: { householdId: HH, data: { enabledMealTypes: ['DINNER'] } },
        service: 'updateMealTypes',
      },
      {
        event: 'households:updateMealTimes',
        invoke: (c, p) => gateway.updateMealTimes(c, p),
        payload: { householdId: HH, data: { mealSlotTimes: {} } },
        service: 'updateMealTimes',
      },
      {
        event: 'households:listMembers',
        invoke: (c, p) => gateway.listMembers(c, p),
        payload: { householdId: HH },
        service: 'listMembers',
      },
      {
        event: 'households:updateMemberRole',
        invoke: (c, p) => gateway.updateMemberRole(c, p),
        payload: {
          householdId: HH,
          memberUserId: 'user-2',
          data: { role: 'OWNER' },
        },
        service: 'updateMemberRole',
      },
      {
        event: 'households:removeMember',
        invoke: (c, p) => gateway.removeMember(c, p),
        payload: { householdId: HH, memberUserId: 'user-2' },
        service: 'removeMember',
      },
      {
        event: 'households:leave',
        invoke: (c, p) => gateway.leave(c, p),
        payload: { householdId: HH },
        service: 'leave',
      },
    ];

    it('tabela obejmuje wszystkie 15 handlerów', () => {
      expect(cases).toHaveLength(15);
      expect(new Set(cases.map((c) => c.event)).size).toBe(15);
    });

    it.each(cases)(
      '$event: socket bez tożsamości → ack UNAUTHORIZED, serwis nietknięty',
      async ({ invoke, payload }) => {
        const response = await invoke(anonClient(), {
          ...payload,
          userId: 'attacker',
        });

        expect(response).toEqual(
          expect.objectContaining({
            ok: false,
            code: 'UNAUTHORIZED',
            status: 401,
          }),
        );
        for (const fn of Object.values(householdsService)) {
          expect(fn).not.toHaveBeenCalled();
        }
        for (const fn of Object.values(notificationsService)) {
          expect(fn).not.toHaveBeenCalled();
        }
        expect(emit).not.toHaveBeenCalled();
        expect(inRoom).not.toHaveBeenCalled();
      },
    );

    it.each(cases)(
      '$event: socket z tokenem ignoruje payload.userId',
      async ({ invoke, payload, service }) => {
        const response = await invoke(tokenClient('victim'), {
          ...payload,
          userId: 'attacker',
        });

        expect(response).toEqual(expect.objectContaining({ ok: true }));
        expect(householdsService[service]).toHaveBeenCalledTimes(1);
        expect(householdsService[service].mock.calls[0][0]).toBe('victim');
        for (const call of householdsService.getUserDisplayName.mock.calls) {
          expect(call[0]).toBe('victim');
        }
        for (const body of emit.mock.calls.map(([, b]) => b)) {
          expect(body.changedByUserId).toBe('victim');
        }
      },
    );

    it.each(cases)(
      '$event: socket legacy bierze tożsamość z payload.userId',
      async ({ invoke, payload, service }) => {
        const response = await invoke(legacyClient(), {
          ...payload,
          userId: 'legacy-user',
        });

        expect(response).toEqual(expect.objectContaining({ ok: true }));
        expect(householdsService[service]).toHaveBeenCalledTimes(1);
        expect(householdsService[service].mock.calls[0][0]).toBe('legacy-user');
      },
    );

    it('socket legacy BEZ payload.userId → UNAUTHORIZED', async () => {
      const response = await gateway.findAll(legacyClient(), {} as any);
      expect(response).toEqual(
        expect.objectContaining({ ok: false, code: 'UNAUTHORIZED' }),
      );
      expect(householdsService.findAll).not.toHaveBeenCalled();
    });
  });

  describe('households:create', () => {
    it('dołącza założyciela do pokoju domu PRZED rozgłoszeniem składu', async () => {
      householdsService.create.mockResolvedValue({ id: 'hh-new', name: 'Dom' });

      const response = await gateway.create(tokenClient(USER), {
        data: { name: 'Dom' },
      } as any);

      expect(response).toEqual(expect.objectContaining({ ok: true }));
      expect(inRoom).toHaveBeenCalledWith('user:' + USER);
      expect(socketsJoin).toHaveBeenCalledWith('household:hh-new');
      expect(to).toHaveBeenCalledWith(['household:hh-new', 'legacy']);
      expect(emitted('households:membersChanged')).toEqual([
        expect.objectContaining({
          householdId: 'hh-new',
          action: 'CREATE_HOUSEHOLD',
          changedByUserId: USER,
          changedByDisplayName: 'Ania',
          members: [{ userId: USER }],
        }),
      ]);
      expect(firstCall(socketsJoin)).toBeLessThan(firstCall(emit));
      expect(socketsLeave).not.toHaveBeenCalled();
      expectAllEmitsRoomScoped();
    });

    it('błąd serwisu: brak joina i brak emitu', async () => {
      householdsService.create.mockRejectedValue(new Error('boom'));

      const response = await gateway.create(tokenClient(USER), {
        data: { name: 'Dom' },
      } as any);

      expect(response).toEqual(expect.objectContaining({ ok: false }));
      expect(inRoom).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('households:removeMember', () => {
    it('rozgłasza skład z listą domowników i plan dla dotkniętych tygodni', async () => {
      householdsService.removeMember.mockResolvedValue({
        id: 'm-1',
        touchedWeekStarts: ['2026-08-24', '2026-08-31'],
      });

      const response = await gateway.removeMember(tokenClient(USER), {
        // Tożsamość ma iść z socketu, nie stąd.
        userId: 'attacker',
        householdId: HH,
        memberUserId: 'user-2',
      } as any);

      expect(response).toEqual(expect.objectContaining({ ok: true }));
      expect(householdsService.removeMember).toHaveBeenCalledWith(
        USER,
        HH,
        'user-2',
      );
      expect(emitted('households:membersChanged')).toEqual([
        expect.objectContaining({
          householdId: HH,
          action: 'REMOVE_MEMBER',
          changedByUserId: USER,
          changedByDisplayName: 'Ania',
          members: [{ userId: USER }],
        }),
      ]);
      expect(emitted('weeklyPlans:weekChanged')).toEqual([
        expect.objectContaining({
          householdId: HH,
          weekStart: '2026-08-24',
          action: 'MEMBERSHIP_CHANGED',
          changedByUserId: USER,
        }),
        expect.objectContaining({
          householdId: HH,
          weekStart: '2026-08-31',
          action: 'MEMBERSHIP_CHANGED',
        }),
      ]);
      expect(emitted('weeklyPlans:shoppingListChanged')).toHaveLength(2);
      for (const rooms of to.mock.calls.map(([r]) => r)) {
        expect(rooms).toEqual(LEGACY);
      }
      expectAllEmitsRoomScoped();
    });

    it('usuwany opuszcza pokój domu dopiero PO emitach', async () => {
      householdsService.removeMember.mockResolvedValue({
        id: 'm-1',
        touchedWeekStarts: ['2026-08-24'],
      });

      await gateway.removeMember(tokenClient(USER), {
        householdId: HH,
        memberUserId: 'user-2',
      } as any);

      expect(inRoom).toHaveBeenCalledTimes(1);
      expect(inRoom).toHaveBeenCalledWith('user:user-2');
      expect(socketsLeave).toHaveBeenCalledWith('household:' + HH);
      expect(socketsJoin).not.toHaveBeenCalled();
      expect(lastCall(emit)).toBeLessThan(firstCall(socketsLeave));
    });

    it('bez dotkniętych tygodni nie rozgłasza planu', async () => {
      householdsService.removeMember.mockResolvedValue({
        id: 'm-1',
        touchedWeekStarts: [],
      });

      await gateway.removeMember(tokenClient(USER), {
        householdId: HH,
        memberUserId: 'user-2',
      } as any);

      expect(emitted('weeklyPlans:weekChanged')).toEqual([]);
      expect(emitted('households:membersChanged')).toHaveLength(1);
    });

    it('błąd serwisu wraca jako ok:false i niczego nie rozgłasza', async () => {
      householdsService.removeMember.mockRejectedValue(new Error('boom'));

      const response = await gateway.removeMember(tokenClient(USER), {
        householdId: HH,
        memberUserId: 'user-2',
      } as any);

      expect(response).toEqual(expect.objectContaining({ ok: false }));
      expect(emit).not.toHaveBeenCalled();
      expect(inRoom).not.toHaveBeenCalled();
    });
  });

  describe('households:leave', () => {
    it('gdy autor jest już poza domem, zdarzenie idzie BEZ listy domowników', async () => {
      householdsService.leave.mockResolvedValue({
        success: true,
        householdDeleted: false,
        touchedWeekStarts: ['2026-08-24'],
      });
      householdsService.listMembers.mockRejectedValue(
        new Error('User is not a member of this household'),
      );

      await gateway.leave(tokenClient(USER), { householdId: HH } as any);

      const [event] = emitted('households:membersChanged');
      expect(event).toEqual(
        expect.objectContaining({
          householdId: HH,
          action: 'LEAVE',
          changedByUserId: USER,
        }),
      );
      expect(event).not.toHaveProperty('members');
      expect(to).toHaveBeenCalledWith(LEGACY);
      expect(emitted('weeklyPlans:weekChanged')).toHaveLength(1);
      expect(
        notificationsService.notifyHouseholdMembershipChanged,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          householdId: HH,
          actorUserId: USER,
          action: 'LEFT',
        }),
      );
      expectAllEmitsRoomScoped();
    });

    it('odchodzący opuszcza pokój domu dopiero PO emitach', async () => {
      householdsService.leave.mockResolvedValue({
        success: true,
        householdDeleted: false,
        touchedWeekStarts: ['2026-08-24'],
      });

      await gateway.leave(tokenClient(USER), { householdId: HH } as any);

      expect(inRoom).toHaveBeenCalledTimes(1);
      expect(inRoom).toHaveBeenCalledWith('user:' + USER);
      expect(socketsLeave).toHaveBeenCalledWith('household:' + HH);
      expect(socketsJoin).not.toHaveBeenCalled();
      expect(emit.mock.calls).toHaveLength(3);
      expect(lastCall(emit)).toBeLessThan(firstCall(socketsLeave));
    });
  });

  describe('households:acceptInvitation', () => {
    const accepted = {
      id: 'm-joined',
      householdId: HH,
      leftHouseholdIds: ['hh-old'],
      touchedWeeks: [
        { householdId: 'hh-old', weekStart: '2026-08-24' },
        { householdId: HH, weekStart: '2026-08-24' },
      ],
    };

    it('rozgłasza nowy dom, opuszczone domy i plan w każdym dotkniętym domu', async () => {
      householdsService.acceptInvitation.mockResolvedValue(accepted);

      const response = await gateway.acceptInvitation(tokenClient(USER), {
        data: { token: 'tok-12345678', leaveOtherHouseholds: true },
      } as any);

      expect(response).toEqual(expect.objectContaining({ ok: true }));
      expect(householdsService.acceptInvitation).toHaveBeenCalledWith(USER, {
        token: 'tok-12345678',
        leaveOtherHouseholds: true,
      });
      expect(
        emitted('households:membersChanged').map((e) => [
          e.householdId,
          e.action,
          e.changedByUserId,
        ]),
      ).toEqual([
        [HH, 'ACCEPT_INVITATION', USER],
        ['hh-old', 'LEAVE', USER],
      ]);
      expect(
        emitted('weeklyPlans:weekChanged').map((e) => e.householdId),
      ).toEqual(['hh-old', HH]);
      // Każdy dom dostaje tylko swoje zdarzenia.
      expect(to).toHaveBeenCalledWith(LEGACY);
      expect(to).toHaveBeenCalledWith(['household:hh-old', 'legacy']);
      expectAllEmitsRoomScoped();
      expect(
        notificationsService.notifyHouseholdMembershipChanged,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          householdId: 'hh-old',
          actorUserId: USER,
          action: 'LEFT',
        }),
      );
    });

    it('JOIN do nowego domu przed emitami, LEAVE z opuszczonych po emitach', async () => {
      householdsService.acceptInvitation.mockResolvedValue(accepted);

      await gateway.acceptInvitation(tokenClient(USER), {
        data: { token: 'tok-12345678', leaveOtherHouseholds: true },
      } as any);

      for (const room of inRoom.mock.calls.map(([r]) => r)) {
        expect(room).toBe('user:' + USER);
      }
      expect(socketsJoin).toHaveBeenCalledTimes(1);
      expect(socketsJoin).toHaveBeenCalledWith('household:' + HH);
      expect(socketsLeave).toHaveBeenCalledTimes(1);
      expect(socketsLeave).toHaveBeenCalledWith('household:hh-old');
      expect(firstCall(socketsJoin)).toBeLessThan(firstCall(emit));
      expect(lastCall(emit)).toBeLessThan(firstCall(socketsLeave));
    });

    it('bez opuszczonych domów: tylko join, bez leave', async () => {
      await gateway.acceptInvitation(tokenClient(USER), {
        data: { token: 'tok-12345678' },
      } as any);

      expect(socketsJoin).toHaveBeenCalledWith('household:' + HH);
      expect(socketsLeave).not.toHaveBeenCalled();
    });
  });

  describe('households:updateName / updateMemberRole', () => {
    it('updateName rozgłasza skład do pokoju domu', async () => {
      await gateway.updateName(tokenClient(USER), {
        householdId: HH,
        data: { name: 'Nowy' },
      } as any);

      expect(to).toHaveBeenCalledWith(LEGACY);
      expect(emitted('households:membersChanged')).toEqual([
        expect.objectContaining({
          householdId: HH,
          action: 'UPDATE_NAME',
          changedByUserId: USER,
          members: [{ userId: USER }],
        }),
      ]);
      expect(inRoom).not.toHaveBeenCalled();
      expectAllEmitsRoomScoped();
    });

    it('updateMemberRole rozgłasza skład do pokoju domu', async () => {
      await gateway.updateMemberRole(tokenClient(USER), {
        householdId: HH,
        memberUserId: 'user-2',
        data: { role: 'OWNER' },
      } as any);

      expect(householdsService.updateMemberRole).toHaveBeenCalledWith(
        USER,
        HH,
        'user-2',
        { role: 'OWNER' },
      );
      expect(to).toHaveBeenCalledWith(LEGACY);
      expect(emitted('households:membersChanged')).toEqual([
        expect.objectContaining({
          householdId: HH,
          action: 'UPDATE_MEMBER_ROLE',
          changedByUserId: USER,
        }),
      ]);
      expect(inRoom).not.toHaveBeenCalled();
      expectAllEmitsRoomScoped();
    });
  });

  describe('households:updateMealTypes / updateMealTimes', () => {
    it('mealTypesChanged idzie do pokoju domu z nową listą', async () => {
      await gateway.updateMealTypes(tokenClient(USER), {
        householdId: HH,
        data: { enabledMealTypes: ['BREAKFAST', 'DINNER'] },
      } as any);

      expect(to).toHaveBeenCalledWith(LEGACY);
      expect(emitted('households:mealTypesChanged')).toEqual([
        {
          householdId: HH,
          mealTypes: ['BREAKFAST', 'DINNER'],
          changedByUserId: USER,
          changedByDisplayName: 'Ania',
        },
      ]);
      expectAllEmitsRoomScoped();
    });

    it('mealTimesChanged idzie do pokoju domu z nowymi godzinami', async () => {
      await gateway.updateMealTimes(tokenClient(USER), {
        householdId: HH,
        data: { mealSlotTimes: { BREAKFAST: '08:00' } },
      } as any);

      expect(to).toHaveBeenCalledWith(LEGACY);
      expect(emitted('households:mealTimesChanged')).toEqual([
        {
          householdId: HH,
          mealSlotTimes: { BREAKFAST: '08:00' },
          changedByUserId: USER,
          changedByDisplayName: 'Ania',
        },
      ]);
      expectAllEmitsRoomScoped();
    });
  });

  describe('households:previewInvitation', () => {
    it('powiadomienie o zaproszeniu idzie do tożsamości z socketu', async () => {
      householdsService.previewInvitation.mockResolvedValue({
        addedToInbox: true,
        household: { id: HH, name: 'Dom' },
        invitedByDisplayName: 'Ola',
      });

      await gateway.previewInvitation(tokenClient(USER), {
        userId: 'attacker',
        data: { token: 'tok-12345678' },
      } as any);

      expect(
        notificationsService.notifyHouseholdInvitation,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ invitedUserId: USER, householdId: HH }),
      );
      expect(emit).not.toHaveBeenCalled();
    });
  });
});
