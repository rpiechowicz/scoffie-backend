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

const HH = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const USER = '11111111-1111-4111-8111-111111111111';
/** Inny domownik (cel removeMember / updateMemberRole). */
const MEMBER = '22222222-2222-4222-8222-222222222222';
/** Dom opuszczany przy acceptInvitation. */
const OTHER_HH = '44444444-4444-4444-8444-444444444444';
const NEW_HH = '55555555-5555-4555-8555-555555555555';
/** Tożsamość socketu legacy — musi być UUID, inaczej `actorId` odrzuca. */
const LEGACY_USER = '88888888-8888-4888-8888-888888888888';
const VICTIM = '99999999-9999-4999-8999-999999999999';
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
        .mockResolvedValue({ mealSlotTimes: { BREAKFAST: 480 } }),
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
        payload: { householdId: HH, data: {} },
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
        payload: { householdId: HH, data: { mealTypes: ['DINNER'] } },
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
          memberUserId: MEMBER,
          data: { role: 'OWNER' },
        },
        service: 'updateMemberRole',
      },
      {
        event: 'households:removeMember',
        invoke: (c, p) => gateway.removeMember(c, p),
        payload: { householdId: HH, memberUserId: MEMBER },
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
        const response = await invoke(tokenClient(VICTIM), {
          ...payload,
          userId: 'attacker',
        });

        expect(response).toEqual(expect.objectContaining({ ok: true }));
        expect(householdsService[service]).toHaveBeenCalledTimes(1);
        expect(householdsService[service].mock.calls[0][0]).toBe(VICTIM);
        for (const call of householdsService.getUserDisplayName.mock.calls) {
          expect(call[0]).toBe(VICTIM);
        }
        for (const body of emit.mock.calls.map(([, b]) => b)) {
          expect(body.changedByUserId).toBe(VICTIM);
        }
      },
    );

    it.each(cases)(
      '$event: socket legacy bierze tożsamość z payload.userId',
      async ({ invoke, payload, service }) => {
        const response = await invoke(legacyClient(), {
          ...payload,
          userId: LEGACY_USER,
        });

        expect(response).toEqual(expect.objectContaining({ ok: true }));
        expect(householdsService[service]).toHaveBeenCalledTimes(1);
        expect(householdsService[service].mock.calls[0][0]).toBe(LEGACY_USER);
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

  describe('walidacja koperty (validateWsPayload) — każdy handler czytający payload', () => {
    type InvalidCase = {
      event: string;
      label: string;
      invoke: (client: any, payload: any) => Promise<unknown>;
      payload: Record<string, unknown>;
      /** Fragment oczekiwanego wpisu w `details`. */
      detail: RegExp;
    };

    const noData = /data must be an object/;
    const badHousehold = /householdId must be a UUID/;
    const badMember = /memberUserId must be a UUID/;

    const cases: InvalidCase[] = [
      {
        event: 'households:findById',
        label: 'id nie-UUID',
        invoke: (c, p) => gateway.findById(c, p),
        payload: { id: 'hh-1' },
        detail: /id must be a UUID/,
      },
      {
        event: 'households:create',
        label: 'brak data',
        invoke: (c, p) => gateway.create(c, p),
        payload: {},
        detail: noData,
      },
      {
        event: 'households:createInvitation',
        label: 'householdId nie-UUID (data opcjonalne)',
        invoke: (c, p) => gateway.createInvitation(c, p),
        payload: { householdId: 'hh-1' },
        detail: badHousehold,
      },
      {
        event: 'households:acceptInvitation',
        label: 'brak data',
        invoke: (c, p) => gateway.acceptInvitation(c, p),
        payload: {},
        detail: noData,
      },
      {
        event: 'households:previewInvitation',
        label: 'data napisem',
        invoke: (c, p) => gateway.previewInvitation(c, p),
        payload: { data: 'tok-12345678' },
        detail: noData,
      },
      {
        event: 'households:declineInvitation',
        label: 'brak data',
        invoke: (c, p) => gateway.declineInvitation(c, p),
        payload: {},
        detail: noData,
      },
      {
        event: 'households:updateName',
        label: 'brak data',
        invoke: (c, p) => gateway.updateName(c, p),
        payload: { householdId: HH },
        detail: noData,
      },
      {
        event: 'households:updateMealTypes',
        label: 'householdId nie-UUID',
        invoke: (c, p) => gateway.updateMealTypes(c, p),
        payload: { householdId: 'hh-1', data: { mealTypes: ['DINNER'] } },
        detail: badHousehold,
      },
      {
        event: 'households:updateMealTimes',
        label: 'brak data',
        invoke: (c, p) => gateway.updateMealTimes(c, p),
        payload: { householdId: HH },
        detail: noData,
      },
      {
        event: 'households:listMembers',
        label: 'brak householdId',
        invoke: (c, p) => gateway.listMembers(c, p),
        payload: {},
        detail: badHousehold,
      },
      {
        event: 'households:updateMemberRole',
        label: 'memberUserId nie-UUID',
        invoke: (c, p) => gateway.updateMemberRole(c, p),
        payload: {
          householdId: HH,
          memberUserId: 'user-2',
          data: { role: 'OWNER' },
        },
        detail: badMember,
      },
      {
        event: 'households:removeMember',
        label: 'brak memberUserId',
        invoke: (c, p) => gateway.removeMember(c, p),
        payload: { householdId: HH },
        detail: badMember,
      },
      {
        event: 'households:leave',
        label: 'householdId nie-UUID',
        invoke: (c, p) => gateway.leave(c, p),
        payload: { householdId: 'hh-1' },
        detail: badHousehold,
      },
    ];

    it('tabela obejmuje 13 handlerów z kopertą (findAll i listPendingInvitations nie czytają payloadu)', () => {
      expect(new Set(cases.map((c) => c.event)).size).toBe(13);
    });

    it.each(cases)(
      '$event: $label → ack VALIDATION_ERROR 400 z details, serwis nietknięty',
      async ({ invoke, payload, detail }) => {
        const response = await invoke(tokenClient(USER), payload);

        expect(response).toEqual(
          expect.objectContaining({
            ok: false,
            code: 'VALIDATION_ERROR',
            status: 400,
            details: expect.arrayContaining([expect.stringMatching(detail)]),
          }),
        );
        for (const fn of Object.values(householdsService)) {
          expect(fn).not.toHaveBeenCalled();
        }
        expect(emit).not.toHaveBeenCalled();
        expect(inRoom).not.toHaveBeenCalled();
      },
    );

    it.each(cases)(
      '$event: anonimowy socket ze złą kopertą → nadal UNAUTHORIZED (tożsamość przed kopertą)',
      async ({ invoke, payload }) => {
        const response = await invoke(anonClient(), payload);
        expect(response).toEqual(
          expect.objectContaining({ ok: false, code: 'UNAUTHORIZED' }),
        );
      },
    );

    it('UUID wielkimi literami (iOS `uuidString`) przechodzi przez kopertę', async () => {
      const response = await gateway.listMembers(tokenClient(USER), {
        householdId: HH.toUpperCase(),
      } as any);
      expect(response).toEqual(expect.objectContaining({ ok: true }));
      expect(householdsService.listMembers).toHaveBeenCalledWith(
        USER,
        HH.toUpperCase(),
      );
    });

    it('nieznane pole na kopercie (stare buildy) nie jest błędem', async () => {
      const response = await gateway.leave(tokenClient(USER), {
        householdId: HH,
        clientVersion: '1.2.3',
      } as any);
      expect(response).toEqual(expect.objectContaining({ ok: true }));
    });

    it('handlery bez koperty przeżywają payload === undefined', async () => {
      const response = await gateway.findAll(
        tokenClient(USER),
        undefined as any,
      );
      expect(response).toEqual(expect.objectContaining({ ok: true }));
      expect(householdsService.findAll).toHaveBeenCalledWith(USER);
    });
  });

  describe('households:create', () => {
    it('dołącza założyciela do pokoju domu PRZED rozgłoszeniem składu', async () => {
      householdsService.create.mockResolvedValue({ id: NEW_HH, name: 'Dom' });

      const response = await gateway.create(tokenClient(USER), {
        data: { name: 'Dom' },
      } as any);

      expect(response).toEqual(expect.objectContaining({ ok: true }));
      expect(inRoom).toHaveBeenCalledWith('user:' + USER);
      expect(socketsJoin).toHaveBeenCalledWith('household:' + NEW_HH);
      expect(to).toHaveBeenCalledWith(['household:' + NEW_HH, 'legacy']);
      expect(emitted('households:membersChanged')).toEqual([
        expect.objectContaining({
          householdId: NEW_HH,
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
        memberUserId: MEMBER,
      } as any);

      expect(response).toEqual(expect.objectContaining({ ok: true }));
      expect(householdsService.removeMember).toHaveBeenCalledWith(
        USER,
        HH,
        MEMBER,
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
        memberUserId: MEMBER,
      } as any);

      expect(inRoom).toHaveBeenCalledTimes(1);
      expect(inRoom).toHaveBeenCalledWith('user:' + MEMBER);
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
        memberUserId: MEMBER,
      } as any);

      expect(emitted('weeklyPlans:weekChanged')).toEqual([]);
      expect(emitted('households:membersChanged')).toHaveLength(1);
    });

    it('błąd serwisu wraca jako ok:false i niczego nie rozgłasza', async () => {
      householdsService.removeMember.mockRejectedValue(new Error('boom'));

      const response = await gateway.removeMember(tokenClient(USER), {
        householdId: HH,
        memberUserId: MEMBER,
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
      leftHouseholdIds: [OTHER_HH],
      touchedWeeks: [
        { householdId: OTHER_HH, weekStart: '2026-08-24' },
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
        [OTHER_HH, 'LEAVE', USER],
      ]);
      expect(
        emitted('weeklyPlans:weekChanged').map((e) => e.householdId),
      ).toEqual([OTHER_HH, HH]);
      // Każdy dom dostaje tylko swoje zdarzenia.
      expect(to).toHaveBeenCalledWith(LEGACY);
      expect(to).toHaveBeenCalledWith(['household:' + OTHER_HH, 'legacy']);
      expectAllEmitsRoomScoped();
      expect(
        notificationsService.notifyHouseholdMembershipChanged,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          householdId: OTHER_HH,
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
      expect(socketsLeave).toHaveBeenCalledWith('household:' + OTHER_HH);
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
        memberUserId: MEMBER,
        data: { role: 'OWNER' },
      } as any);

      expect(householdsService.updateMemberRole).toHaveBeenCalledWith(
        USER,
        HH,
        MEMBER,
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
        data: { mealTypes: ['BREAKFAST', 'DINNER'] },
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
        data: { mealSlotTimes: { BREAKFAST: 480 } },
      } as any);

      expect(to).toHaveBeenCalledWith(LEGACY);
      expect(emitted('households:mealTimesChanged')).toEqual([
        {
          householdId: HH,
          mealSlotTimes: { BREAKFAST: 480 },
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
