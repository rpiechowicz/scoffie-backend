import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { HouseholdsService } from './households.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppException } from '../common/app-exception';

// Ten spec testuje PRAWDZIWY `HouseholdsService`. Wcześniej `jest.config.js`
// podmieniał moduł na stub o innym API (`createHousehold`, `householdInvitation`),
// więc 15 zielonych testów nie sprawdzało ani jednej linii produkcyjnego kodu.
// Hooki składu domu (`plan-roster.util`) i porządkowanie
// (`household-cleanup.util`) biegną tu naprawdę — mock oddaje ten sam obiekt
// do `$transaction`, więc każde wywołanie w transakcji jest widoczne.

// ─── Mock data ─────────────────────────────────────────────────────────────────

const OWNER = 'user-owner';
const MEMBER = 'user-member';
const STRANGER = 'user-stranger';
const HH = 'hh-1';
const OTHER_HH = 'hh-old';

const household = { id: HH, name: 'Dom', createdById: OWNER };
const ownerMembership = { id: 'm-owner', userId: OWNER, householdId: HH, role: 'OWNER' as const, createdAt: new Date('2026-01-01') };
const memberMembership = { id: 'm-member', userId: MEMBER, householdId: HH, role: 'MEMBER' as const, createdAt: new Date('2026-02-01') };

const futureInvitation = () => ({
  id: 'inv-1',
  token: 'tok-12345678',
  householdId: HH,
  createdById: OWNER,
  redeemedById: null,
  redeemedAt: null,
  declinedAt: null,
  invitedUserId: null,
  expiresAt: new Date(Date.now() + 86_400_000),
  createdAt: new Date('2026-08-01'),
});

type MockState = {
  /** Członkostwa w domu HH (dla `settleHouseholdAfterMemberLeft`, listMembers). */
  membersOfHousehold: Record<string, Array<typeof ownerMembership | typeof memberMembership>>;
  /** Członkostwa użytkownika (dla `acceptInvitation`, `create`). */
  membershipsOfUser: Record<string, Array<{ householdId: string }>>;
  /** Kolejka odpowiedzi `membership.count({ householdId })` per dom. */
  memberCounts: Record<string, number[]>;
  ownerCount: number;
};

const makePrismaMock = (state: MockState) => {
  const mock: any = {
    household: {
      findUnique: jest.fn().mockResolvedValue(household),
      findMany: jest.fn().mockResolvedValue([household]),
      create: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'hh-new', ...data }),
      ),
      update: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ ...household, ...data }),
      ),
      delete: jest.fn().mockResolvedValue(household),
    },
    membership: {
      findUnique: jest.fn().mockImplementation(({ where }: any) => {
        const { userId, householdId } = where.userId_householdId;
        const found = (state.membersOfHousehold[householdId] ?? []).find(
          (m) => m.userId === userId,
        );
        return Promise.resolve(found ?? null);
      }),
      findFirst: jest.fn().mockImplementation(({ where }: any) =>
        Promise.resolve(state.membershipsOfUser[where.userId]?.[0] ?? null),
      ),
      findMany: jest.fn().mockImplementation(({ where }: any) => {
        if (where?.userId) {
          const all = state.membershipsOfUser[where.userId] ?? [];
          const not = where.householdId?.not;
          return Promise.resolve(
            not ? all.filter((m) => m.householdId !== not) : all,
          );
        }
        return Promise.resolve(state.membersOfHousehold[where.householdId] ?? []);
      }),
      count: jest.fn().mockImplementation(({ where }: any) => {
        if (where?.role === 'OWNER') return Promise.resolve(state.ownerCount);
        const queue = state.memberCounts[where.householdId];
        if (queue && queue.length > 0) {
          return Promise.resolve(queue.length > 1 ? queue.shift() : queue[0]);
        }
        return Promise.resolve(
          (state.membersOfHousehold[where.householdId] ?? []).length,
        );
      }),
      create: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'm-new', ...data }),
      ),
      upsert: jest.fn().mockImplementation(({ create }: any) =>
        Promise.resolve({ id: 'm-joined', ...create }),
      ),
      update: jest.fn().mockImplementation(({ where, data }: any) =>
        Promise.resolve({ ...where, ...data }),
      ),
      delete: jest.fn().mockImplementation(({ where }: any) =>
        Promise.resolve({ id: 'm-deleted', ...where.userId_householdId }),
      ),
    },
    invitation: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'inv-new', ...data }),
      ),
      update: jest.fn().mockResolvedValue({}),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ displayName: 'Ania' }),
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ id: MEMBER, avatarColor: 3 }),
      findMany: jest.fn().mockResolvedValue([{ id: OWNER, avatarColor: 0 }]),
      update: jest.fn().mockResolvedValue({}),
    },
    weeklyPlan: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    planItem: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    planItemParticipant: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    planItemConsumption: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    shoppingList: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: jest.fn().mockImplementation((cbOrOps: any) => {
      if (typeof cbOrOps === 'function') return cbOrOps(mock);
      return Promise.all(cbOrOps);
    }),
  };
  return mock;
};

const defaultState = (): MockState => ({
  membersOfHousehold: { [HH]: [ownerMembership, memberMembership] },
  membershipsOfUser: {
    [OWNER]: [{ householdId: HH }],
    [MEMBER]: [{ householdId: HH }],
  },
  memberCounts: {},
  ownerCount: 1,
});

const expectCode = async (attempt: Promise<unknown>, code: string) => {
  await expect(attempt).rejects.toThrow(AppException);
  await expect(attempt).rejects.toMatchObject({ response: { code } });
};

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('HouseholdsService', () => {
  let service: HouseholdsService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let state: MockState;

  beforeEach(async () => {
    state = defaultState();
    prisma = makePrismaMock(state);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HouseholdsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<HouseholdsService>(HouseholdsService);
  });

  // ─── create ───────────────────────────────────────────────────────────────

  describe('create', () => {
    it('zakłada dom i członkostwo OWNER w jednej transakcji', async () => {
      state.membershipsOfUser[STRANGER] = [];

      const result = await service.create(STRANGER, { name: 'Nowy dom' });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.household.create).toHaveBeenCalledWith({
        data: { name: 'Nowy dom', createdById: STRANGER },
      });
      expect(prisma.membership.create).toHaveBeenCalledWith({
        data: { userId: STRANGER, householdId: 'hh-new', role: 'OWNER' },
      });
      expect(result).toMatchObject({ id: 'hh-new', name: 'Nowy dom' });
    });

    it('odrzuca drugie gospodarstwo jako HOUSEHOLD_ALREADY_MEMBER 409', async () => {
      const attempt = service.create(OWNER, { name: 'Drugi dom' });

      await expectCode(attempt, 'HOUSEHOLD_ALREADY_MEMBER');
      await expect(attempt).rejects.toMatchObject({ status: 409 });
      expect(prisma.household.create).not.toHaveBeenCalled();
    });
  });

  // ─── createInvitation ─────────────────────────────────────────────────────

  describe('createInvitation', () => {
    it('nie-członek dostaje 403', async () => {
      await expect(
        service.createInvitation(STRANGER, HH, {}),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.invitation.create).not.toHaveBeenCalled();
    });

    it('członek bez roli OWNER dostaje 403', async () => {
      await expect(service.createInvitation(MEMBER, HH, {})).rejects.toThrow(
        /Only owners/,
      );
    });

    it('właściciel dostaje token i 7-dniowy termin', async () => {
      const before = Date.now();
      const result = await service.createInvitation(OWNER, HH, {});

      const arg = prisma.invitation.create.mock.calls[0][0].data;
      expect(arg.householdId).toBe(HH);
      expect(arg.createdById).toBe(OWNER);
      expect(arg.token).toMatch(/^[0-9a-f]{32}$/);
      expect(arg.expiresAt.getTime()).toBeGreaterThanOrEqual(
        before + 7 * 86_400_000 - 1000,
      );
      expect(result.token).toBe(arg.token);
    });

    it('jawny expiresAt wygrywa z domyślnym', async () => {
      await service.createInvitation(OWNER, HH, {
        expiresAt: '2026-12-31T23:59:59.000Z',
      });
      expect(
        prisma.invitation.create.mock.calls[0][0].data.expiresAt.toISOString(),
      ).toBe('2026-12-31T23:59:59.000Z');
    });
  });

  // ─── acceptInvitation ─────────────────────────────────────────────────────

  describe('acceptInvitation', () => {
    const dto = { token: 'tok-12345678' };

    beforeEach(() => {
      state.membershipsOfUser[STRANGER] = [];
      state.membersOfHousehold[HH] = [ownerMembership];
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        id: STRANGER,
        avatarColor: 3,
      });
    });

    it('nieznany token → NotFound', async () => {
      await expect(service.acceptInvitation(STRANGER, dto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it.each([
      ['wykorzystane', { redeemedAt: new Date() }, 'INVITATION_ALREADY_REDEEMED'],
      ['po terminie', { expiresAt: new Date(Date.now() - 1000) }, 'INVITATION_EXPIRED'],
      ['odrzucone', { declinedAt: new Date() }, 'INVITATION_DECLINED'],
    ])('%s → %s', async (_label, patch, code) => {
      prisma.invitation.findUnique.mockResolvedValue({
        ...futureInvitation(),
        ...patch,
      });

      await expectCode(service.acceptInvitation(STRANGER, dto), code);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('inne gospodarstwo bez leaveOtherHouseholds → INVITATION_REQUIRES_LEAVE 409', async () => {
      prisma.invitation.findUnique.mockResolvedValue(futureInvitation());
      state.membershipsOfUser[STRANGER] = [{ householdId: OTHER_HH }];

      const attempt = service.acceptInvitation(STRANGER, dto);
      await expectCode(attempt, 'INVITATION_REQUIRES_LEAVE');
      await expect(attempt).rejects.toMatchObject({ status: 409 });
      expect(prisma.membership.delete).not.toHaveBeenCalled();
    });

    it('dołączenie: upsert MEMBER, zaproszenie oznaczone, liczniki wokół upsertu przeliczają auto-porcje', async () => {
      prisma.invitation.findUnique.mockResolvedValue(futureInvitation());
      // Przed upsertem 1 domownik, po — 2.
      state.memberCounts[HH] = [1, 2];
      prisma.planItem.updateMany.mockResolvedValue({ count: 3 });
      prisma.weeklyPlan.findMany.mockResolvedValue([
        { weekStart: new Date('2026-08-31T00:00:00.000Z') },
      ]);

      const result = await service.acceptInvitation(STRANGER, dto);

      expect(prisma.membership.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: { userId: STRANGER, householdId: HH, role: 'MEMBER' },
        }),
      );
      expect(prisma.invitation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'inv-1' },
          data: expect.objectContaining({
            redeemedById: STRANGER,
            invitedUserId: STRANGER,
          }),
        }),
      );
      // onRosterChanged(1 → 2): „Wspólne" z 1 porcją idą na 2.
      expect(prisma.planItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ plannedServings: 1 }),
          data: { plannedServings: 2 },
        }),
      );
      expect(prisma.shoppingList.updateMany).toHaveBeenCalled();
      expect(result.leftHouseholdIds).toEqual([]);
      expect(result.touchedWeeks).toEqual([
        { householdId: HH, weekStart: '2026-08-31' },
      ]);
    });

    it('ponowne przyjęcie tego samego domu nie przelicza porcji (skład bez zmian)', async () => {
      prisma.invitation.findUnique.mockResolvedValue(futureInvitation());
      state.memberCounts[HH] = [2, 2];

      const result = await service.acceptInvitation(STRANGER, dto);

      expect(prisma.planItem.updateMany).not.toHaveBeenCalled();
      expect(result.touchedWeeks).toEqual([]);
    });

    it('z leaveOtherHouseholds opuszcza stary dom: delete + porządek + hook odejścia', async () => {
      prisma.invitation.findUnique.mockResolvedValue(futureInvitation());
      state.membershipsOfUser[STRANGER] = [{ householdId: OTHER_HH }];
      state.membersOfHousehold[OTHER_HH] = [
        { ...ownerMembership, id: 'm-x', userId: 'user-x', householdId: OTHER_HH },
      ];
      state.memberCounts[OTHER_HH] = [1];
      state.memberCounts[HH] = [1, 2];

      const result = await service.acceptInvitation(STRANGER, {
        ...dto,
        leaveOtherHouseholds: true,
      });

      expect(prisma.membership.delete).toHaveBeenCalledWith({
        where: { userId_householdId: { userId: STRANGER, householdId: OTHER_HH } },
      });
      // Stary dom ma właściciela → zostaje; hook zdejmuje duchy odchodzącego.
      expect(prisma.household.delete).not.toHaveBeenCalled();
      expect(prisma.planItemParticipant.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: STRANGER }),
        }),
      );
      expect(result.leftHouseholdIds).toEqual([OTHER_HH]);
    });

    it('pusty stary dom znika, a hook odejścia jest pominięty', async () => {
      prisma.invitation.findUnique.mockResolvedValue(futureInvitation());
      state.membershipsOfUser[STRANGER] = [{ householdId: OTHER_HH }];
      state.membersOfHousehold[OTHER_HH] = [];
      state.memberCounts[HH] = [1, 2];

      await service.acceptInvitation(STRANGER, {
        ...dto,
        leaveOtherHouseholds: true,
      });

      expect(prisma.household.delete).toHaveBeenCalledWith({
        where: { id: OTHER_HH },
      });
      expect(prisma.planItemParticipant.deleteMany).not.toHaveBeenCalled();
    });

    it('kolor awatara kolidujący z domownikiem dostaje nowy przydział', async () => {
      prisma.invitation.findUnique.mockResolvedValue(futureInvitation());
      state.memberCounts[HH] = [1, 2];
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        id: STRANGER,
        avatarColor: 0,
      });
      prisma.user.findMany.mockResolvedValue([{ id: OWNER, avatarColor: 0 }]);

      await service.acceptInvitation(STRANGER, dto);

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: STRANGER } }),
      );
      expect(prisma.user.update.mock.calls[0][0].data.avatarColor).not.toBe(0);
    });

    it('unikalny kolor awatara zostaje', async () => {
      prisma.invitation.findUnique.mockResolvedValue(futureInvitation());
      state.memberCounts[HH] = [1, 2];

      await service.acceptInvitation(STRANGER, dto);

      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  // ─── previewInvitation / declineInvitation ────────────────────────────────

  describe('previewInvitation', () => {
    it('nieznany token zwraca NOT_FOUND bez rzucania', async () => {
      const result = await service.previewInvitation(STRANGER, {
        token: 'tok-12345678',
      });
      expect(result).toMatchObject({ status: 'NOT_FOUND', household: null });
    });

    it('pierwszy podgląd odkłada zaproszenie do skrzynki adresata', async () => {
      prisma.invitation.findUnique.mockResolvedValue({
        ...futureInvitation(),
        household: { id: HH, name: 'Dom' },
        createdBy: { displayName: 'Ania' },
      });
      state.membershipsOfUser[STRANGER] = [];
      state.membersOfHousehold[HH] = [ownerMembership];

      const result = await service.previewInvitation(STRANGER, {
        token: 'tok-12345678',
      });

      expect(result.addedToInbox).toBe(true);
      expect(prisma.invitation.update).toHaveBeenCalledWith({
        where: { id: 'inv-1' },
        data: { invitedUserId: STRANGER },
      });
    });
  });

  describe('declineInvitation', () => {
    it('oznacza declinedAt i dopisuje adresata tylko, gdy go nie było', async () => {
      prisma.invitation.findUnique.mockResolvedValue({
        id: 'inv-1',
        redeemedAt: null,
        invitedUserId: null,
      });

      await service.declineInvitation(STRANGER, { token: 'tok-12345678' });

      const data = prisma.invitation.update.mock.calls[0][0].data;
      expect(data.declinedAt).toBeInstanceOf(Date);
      expect(data.invitedUserId).toBe(STRANGER);
    });

    it('wykorzystane zaproszenie → INVITATION_ALREADY_REDEEMED', async () => {
      prisma.invitation.findUnique.mockResolvedValue({
        id: 'inv-1',
        redeemedAt: new Date(),
        invitedUserId: OWNER,
      });

      await expectCode(
        service.declineInvitation(STRANGER, { token: 'tok-12345678' }),
        'INVITATION_ALREADY_REDEEMED',
      );
    });
  });

  // ─── updateName / updateMealTypes ─────────────────────────────────────────

  describe('updateName', () => {
    it('tylko właściciel', async () => {
      await expect(
        service.updateName(MEMBER, HH, { name: 'Nowa nazwa' }),
      ).rejects.toThrow(ForbiddenException);
      await service.updateName(OWNER, HH, { name: 'Nowa nazwa' });
      expect(prisma.household.update).toHaveBeenCalledWith({
        where: { id: HH },
        data: { name: 'Nowa nazwa' },
      });
    });

    it('nieznany dom → NotFound', async () => {
      prisma.household.findUnique.mockResolvedValue(null);
      await expect(
        service.updateName(OWNER, 'hh-ghost', { name: 'X' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateMealTypes', () => {
    it('każdy członek może zmienić sloty, ale sloty bazowe zawsze zostają', async () => {
      await service.updateMealTypes(MEMBER, HH, {
        mealTypes: ['SNACK'] as any,
      });

      const saved = prisma.household.update.mock.calls[0][0].data
        .enabledMealTypes as string[];
      expect(saved).toEqual(
        expect.arrayContaining(['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK']),
      );
    });

    it('nie-członek dostaje 403', async () => {
      await expect(
        service.updateMealTypes(STRANGER, HH, { mealTypes: [] as any }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ─── listMembers / updateMemberRole ───────────────────────────────────────

  describe('listMembers', () => {
    it('zwraca domowników z użytkownikiem i kolorem awatara', async () => {
      await service.listMembers(MEMBER, HH);
      expect(prisma.membership.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { householdId: HH },
          include: expect.objectContaining({
            user: expect.objectContaining({
              select: expect.objectContaining({ avatarColor: true }),
            }),
          }),
        }),
      );
    });

    it('nie-członek dostaje 403', async () => {
      await expect(service.listMembers(STRANGER, HH)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('updateMemberRole', () => {
    it('awans na OWNER przez właściciela', async () => {
      await service.updateMemberRole(OWNER, HH, MEMBER, { role: 'OWNER' });
      expect(prisma.membership.update).toHaveBeenCalledWith({
        where: { userId_householdId: { userId: MEMBER, householdId: HH } },
        data: { role: 'OWNER' },
      });
    });

    it('degradacja ostatniego właściciela jest odrzucana', async () => {
      state.ownerCount = 1;
      await expect(
        service.updateMemberRole(OWNER, HH, OWNER, { role: 'MEMBER' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('ta sama rola = brak zapisu', async () => {
      await service.updateMemberRole(OWNER, HH, MEMBER, { role: 'MEMBER' });
      expect(prisma.membership.update).not.toHaveBeenCalled();
    });
  });

  // ─── removeMember / leave ─────────────────────────────────────────────────

  describe('removeMember', () => {
    it('nie-właściciel nie usuwa nikogo', async () => {
      await expect(service.removeMember(MEMBER, HH, OWNER)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('ostatniego właściciela nie da się usunąć', async () => {
      state.ownerCount = 1;
      await expect(service.removeMember(OWNER, HH, OWNER)).rejects.toThrow(
        /last owner/,
      );
      expect(prisma.membership.delete).not.toHaveBeenCalled();
    });

    it('usuwa członkostwo, porządkuje dom i sprząta plan po ODCHODZĄCYM (nie po właścicielu)', async () => {
      state.memberCounts[HH] = [1];
      prisma.weeklyPlan.findMany.mockResolvedValue([
        { weekStart: new Date('2026-09-07T00:00:00.000Z') },
      ]);

      const result = await service.removeMember(OWNER, HH, MEMBER);

      expect(prisma.membership.delete).toHaveBeenCalledWith({
        where: { userId_householdId: { userId: MEMBER, householdId: HH } },
      });
      expect(prisma.planItemParticipant.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: MEMBER }),
        }),
      );
      // 2 → 1: „Wspólne" z 2 porcjami idą na 1.
      expect(prisma.planItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ plannedServings: 2 }),
          data: { plannedServings: 1 },
        }),
      );
      expect(result.touchedWeekStarts).toEqual(['2026-09-07']);
    });
  });

  describe('leave', () => {
    it('ostatni domownik wychodzi: dom znika, hook pominięty', async () => {
      state.membersOfHousehold[HH] = [ownerMembership];
      prisma.membership.findUnique.mockResolvedValue(ownerMembership);
      // Po delete w domu nie ma nikogo.
      prisma.membership.findMany.mockResolvedValue([]);

      const result = await service.leave(OWNER, HH);

      expect(prisma.household.delete).toHaveBeenCalledWith({
        where: { id: HH },
      });
      expect(prisma.planItemParticipant.deleteMany).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        householdDeleted: true,
        touchedWeekStarts: [],
      });
    });

    it('wyjście jedynego właściciela awansuje najstarszego domownika', async () => {
      // Po delete zostaje sam MEMBER.
      prisma.membership.findMany.mockImplementation(({ where }: any) =>
        Promise.resolve(where?.userId ? [] : [memberMembership]),
      );
      state.memberCounts[HH] = [1];

      const result = await service.leave(OWNER, HH);

      expect(prisma.membership.update).toHaveBeenCalledWith({
        where: { id: memberMembership.id },
        data: { role: 'OWNER' },
      });
      expect(prisma.household.delete).not.toHaveBeenCalled();
      expect(prisma.planItemParticipant.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: OWNER }),
        }),
      );
      expect(result.householdDeleted).toBe(false);
    });

    it('nie-członek nie może wyjść z cudzego domu', async () => {
      await expect(service.leave(STRANGER, HH)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('getUserDisplayName', () => {
    it('spada na „Domownik", gdy użytkownika nie ma', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.getUserDisplayName('ghost')).resolves.toBe(
        'Domownik',
      );
    });
  });
});
