import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { HouseholdsService } from './households.service';
import { PrismaService } from '../prisma/prisma.service';

// ─── Mock data ─────────────────────────────────────────────────────────────────

const mockUser = { id: 'user-1', displayName: 'Jan', email: 'jan@example.com' };
const mockUser2 = {
  id: 'user-2',
  displayName: 'Anna',
  email: 'anna@example.com',
};

const mockHousehold = {
  id: 'hh-1',
  name: 'Dom Kowalskich',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockMembership = {
  id: 'mem-1',
  userId: mockUser.id,
  householdId: mockHousehold.id,
  role: 'OWNER',
  createdAt: new Date(),
};

const mockInvitation = {
  id: 'inv-1',
  token: 'valid-token-abc123',
  householdId: mockHousehold.id,
  createdByUserId: mockUser.id,
  expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24), // jutro
  usedAt: null,
};

const makePrismaMock = () => ({
  household: {
    create: jest.fn().mockResolvedValue(mockHousehold),
    findUnique: jest.fn().mockResolvedValue(mockHousehold),
    update: jest.fn().mockResolvedValue(mockHousehold),
    delete: jest.fn().mockResolvedValue(mockHousehold),
  },
  membership: {
    create: jest.fn().mockResolvedValue(mockMembership),
    findFirst: jest.fn().mockResolvedValue(mockMembership),
    findMany: jest.fn().mockResolvedValue([mockMembership]),
    update: jest.fn().mockResolvedValue(mockMembership),
    delete: jest.fn().mockResolvedValue(mockMembership),
  },
  householdInvitation: {
    create: jest.fn().mockResolvedValue(mockInvitation),
    findUnique: jest.fn().mockResolvedValue(mockInvitation),
    update: jest
      .fn()
      .mockResolvedValue({ ...mockInvitation, usedAt: new Date() }),
    findFirst: jest.fn().mockResolvedValue(mockInvitation),
  },
  $transaction: jest.fn().mockImplementation((cb) => cb(makePrismaMock())),
});

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('HouseholdsService', () => {
  let service: HouseholdsService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HouseholdsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<HouseholdsService>(HouseholdsService);
  });

  afterEach(() => jest.clearAllMocks());

  // ─── createHousehold ──────────────────────────────────────────────────────

  describe('createHousehold', () => {
    it('powinno stworzyć household i dodać twórcę jako OWNER', async () => {
      const result = await service.createHousehold(mockUser.id, {
        name: 'Dom Kowalskich',
      });

      expect(prisma.household.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ name: 'Dom Kowalskich' }),
        }),
      );
      expect(result).toMatchObject({
        id: mockHousehold.id,
        name: mockHousehold.name,
      });
    });

    it('powinno odrzucić pustą nazwę', async () => {
      await expect(
        service.createHousehold(mockUser.id, { name: '' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('powinno odrzucić zbyt długą nazwę (>100 znaków)', async () => {
      const longName = 'A'.repeat(101);
      await expect(
        service.createHousehold(mockUser.id, { name: longName }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── createInvitation ─────────────────────────────────────────────────────

  describe('createInvitation', () => {
    it('powinno stworzyć zaproszenie tylko dla OWNER', async () => {
      const result = await service.createInvitation(
        mockUser.id,
        mockHousehold.id,
      );

      expect(prisma.householdInvitation.create).toHaveBeenCalled();
      expect(result).toHaveProperty('token');
    });

    it('powinno odrzucić zaproszenie od non-OWNER', async () => {
      prisma.membership.findFirst.mockResolvedValue({
        ...mockMembership,
        role: 'MEMBER',
      });

      await expect(
        service.createInvitation(mockUser2.id, mockHousehold.id),
      ).rejects.toThrow(ForbiddenException);
    });

    it('powinno odrzucić gdy użytkownik nie należy do household', async () => {
      prisma.membership.findFirst.mockResolvedValue(null);

      await expect(
        service.createInvitation(mockUser.id, mockHousehold.id),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ─── acceptInvitation ─────────────────────────────────────────────────────

  describe('acceptInvitation', () => {
    it('powinno dodać użytkownika do household po ważnym tokenie', async () => {
      prisma.membership.findFirst.mockResolvedValue(null); // user nie jest członkiem

      await service.acceptInvitation(mockUser2.id, 'valid-token-abc123');

      expect(prisma.membership.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: mockUser2.id,
            householdId: mockHousehold.id,
            role: 'MEMBER',
          }),
        }),
      );
    });

    it('powinno odrzucić wygasły token', async () => {
      prisma.householdInvitation.findUnique.mockResolvedValue({
        ...mockInvitation,
        expiresAt: new Date(Date.now() - 1000), // wygasł
      });

      await expect(
        service.acceptInvitation(mockUser2.id, 'expired-token'),
      ).rejects.toThrow();
    });

    it('powinno odrzucić już użyty token', async () => {
      prisma.householdInvitation.findUnique.mockResolvedValue({
        ...mockInvitation,
        usedAt: new Date(Date.now() - 1000), // już użyty
      });

      await expect(
        service.acceptInvitation(mockUser2.id, 'used-token'),
      ).rejects.toThrow();
    });

    it('powinno odrzucić gdy użytkownik już jest w household', async () => {
      // User jest już członkiem
      prisma.membership.findFirst.mockResolvedValue(mockMembership);

      await expect(
        service.acceptInvitation(mockUser.id, 'valid-token-abc123'),
      ).rejects.toThrow();
    });
  });

  // ─── updateMemberRole ─────────────────────────────────────────────────────

  describe('updateMemberRole', () => {
    it('powinno zaktualizować rolę przez OWNER', async () => {
      await service.updateMemberRole(
        mockUser.id,
        mockHousehold.id,
        mockUser2.id,
        'MEMBER',
      );

      expect(prisma.membership.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ role: 'MEMBER' }),
        }),
      );
    });

    it('powinno odrzucić zmianę roli przez non-OWNER', async () => {
      prisma.membership.findFirst.mockResolvedValueOnce({
        ...mockMembership,
        role: 'MEMBER',
      });

      await expect(
        service.updateMemberRole(
          mockUser2.id,
          mockHousehold.id,
          mockUser.id,
          'OWNER',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('nie powinno pozwolić OWNER na degradację samego siebie', async () => {
      await expect(
        service.updateMemberRole(
          mockUser.id,
          mockHousehold.id,
          mockUser.id,
          'MEMBER',
        ),
      ).rejects.toThrow();
    });
  });

  // ─── listMembers ──────────────────────────────────────────────────────────

  describe('listMembers', () => {
    it('powinno zwrócić listę członków household', async () => {
      prisma.membership.findMany.mockResolvedValue([
        { ...mockMembership, user: mockUser },
        {
          ...mockMembership,
          id: 'mem-2',
          userId: mockUser2.id,
          role: 'MEMBER',
          user: mockUser2,
        },
      ]);

      const result = await service.listMembers(mockUser.id, mockHousehold.id);
      expect(result).toHaveLength(2);
    });

    it('powinno odrzucić gdy użytkownik nie należy do household', async () => {
      prisma.membership.findFirst.mockResolvedValue(null);

      await expect(
        service.listMembers('outsider-id', mockHousehold.id),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
