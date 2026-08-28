import { Test, TestingModule } from '@nestjs/testing';
import { HouseholdsGateway } from './households.gateway';
import { HouseholdsService } from './households.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WsTelemetryService } from '../common/ws-telemetry.service';

// Gateway ma dwie rzeczy na własność: listę domowników doklejoną do
// `households:membersChanged` (albo jej brak, gdy autor jest już poza domem)
// i rozgłoszenie planu dla tygodni dotkniętych zmianą składu. Reszta to
// przekazanie wywołania do serwisu.

const HH = 'hh-1';
const USER = 'user-1';

describe('HouseholdsGateway', () => {
  let gateway: HouseholdsGateway;
  let emit: jest.Mock;
  let householdsService: Record<string, jest.Mock>;
  let notificationsService: Record<string, jest.Mock>;

  const emitted = (event: string) =>
    emit.mock.calls.filter(([name]) => name === event).map(([, body]) => body);

  beforeEach(async () => {
    emit = jest.fn();
    householdsService = {
      getUserDisplayName: jest.fn().mockResolvedValue('Ania'),
      listMembers: jest.fn().mockResolvedValue([{ userId: USER }]),
      findById: jest.fn().mockResolvedValue({ id: HH, name: 'Dom' }),
      acceptInvitation: jest.fn(),
      removeMember: jest.fn(),
      leave: jest.fn(),
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
    (gateway as any).server = { emit };
  });

  describe('households:removeMember', () => {
    it('rozgłasza skład z listą domowników i plan dla dotkniętych tygodni', async () => {
      householdsService.removeMember.mockResolvedValue({
        id: 'm-1',
        touchedWeekStarts: ['2026-08-24', '2026-08-31'],
      });

      const response = await gateway.removeMember({
        userId: USER,
        householdId: HH,
        memberUserId: 'user-2',
      } as any);

      expect(response).toEqual(expect.objectContaining({ ok: true }));
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
        expect.objectContaining({ householdId: HH, weekStart: '2026-08-24', action: 'MEMBERSHIP_CHANGED' }),
        expect.objectContaining({ householdId: HH, weekStart: '2026-08-31', action: 'MEMBERSHIP_CHANGED' }),
      ]);
      expect(emitted('weeklyPlans:shoppingListChanged')).toHaveLength(2);
    });

    it('bez dotkniętych tygodni nie rozgłasza planu', async () => {
      householdsService.removeMember.mockResolvedValue({
        id: 'm-1',
        touchedWeekStarts: [],
      });

      await gateway.removeMember({
        userId: USER,
        householdId: HH,
        memberUserId: 'user-2',
      } as any);

      expect(emitted('weeklyPlans:weekChanged')).toEqual([]);
      expect(emitted('households:membersChanged')).toHaveLength(1);
    });

    it('błąd serwisu wraca jako ok:false i niczego nie rozgłasza', async () => {
      householdsService.removeMember.mockRejectedValue(new Error('boom'));

      const response = await gateway.removeMember({
        userId: USER,
        householdId: HH,
        memberUserId: 'user-2',
      } as any);

      expect(response).toEqual(expect.objectContaining({ ok: false }));
      expect(emit).not.toHaveBeenCalled();
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

      await gateway.leave({ userId: USER, householdId: HH } as any);

      const [event] = emitted('households:membersChanged');
      expect(event).toEqual(
        expect.objectContaining({ householdId: HH, action: 'LEAVE' }),
      );
      expect(event).not.toHaveProperty('members');
      expect(emitted('weeklyPlans:weekChanged')).toHaveLength(1);
      expect(
        notificationsService.notifyHouseholdMembershipChanged,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ householdId: HH, action: 'LEFT' }),
      );
    });
  });

  describe('households:acceptInvitation', () => {
    it('rozgłasza nowy dom, opuszczone domy i plan w każdym dotkniętym domu', async () => {
      householdsService.acceptInvitation.mockResolvedValue({
        id: 'm-joined',
        householdId: HH,
        leftHouseholdIds: ['hh-old'],
        touchedWeeks: [
          { householdId: 'hh-old', weekStart: '2026-08-24' },
          { householdId: HH, weekStart: '2026-08-24' },
        ],
      });

      const response = await gateway.acceptInvitation({
        userId: USER,
        data: { token: 'tok-12345678', leaveOtherHouseholds: true },
      } as any);

      expect(response).toEqual(expect.objectContaining({ ok: true }));
      expect(
        emitted('households:membersChanged').map((e) => [
          e.householdId,
          e.action,
        ]),
      ).toEqual([
        [HH, 'ACCEPT_INVITATION'],
        ['hh-old', 'LEAVE'],
      ]);
      expect(
        emitted('weeklyPlans:weekChanged').map((e) => e.householdId),
      ).toEqual(['hh-old', HH]);
      expect(
        notificationsService.notifyHouseholdMembershipChanged,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ householdId: 'hh-old', action: 'LEFT' }),
      );
    });
  });
});
