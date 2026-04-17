import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';

// ─── Mock factories ────────────────────────────────────────────────────────────

const mockUser = {
  id: 'user-123',
  googleId: 'dev:testuser',
  displayName: 'Test User',
  email: 'test@example.com',
  avatarUrl: null,
};

const mockRefreshToken = {
  tokenHash: 'hashed-token',
  userId: 'user-123',
  expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30), // 30 days
  revokedAt: null,
};

const makePrismaMock = () => ({
  user: {
    upsert: jest.fn().mockResolvedValue(mockUser),
    findUnique: jest.fn().mockResolvedValue(mockUser),
  },
  refreshToken: {
    create: jest.fn().mockResolvedValue(mockRefreshToken),
    findUnique: jest.fn().mockResolvedValue(mockRefreshToken),
    update: jest.fn().mockResolvedValue({ ...mockRefreshToken, revokedAt: new Date() }),
  },
  membership: {
    findFirst: jest.fn().mockResolvedValue(null),
  },
});

const makeJwtMock = () => ({
  signAsync: jest.fn().mockResolvedValue('mock-access-token'),
});

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('AuthService', () => {
  let service: AuthService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let jwt: ReturnType<typeof makeJwtMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    jwt = makeJwtMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwt },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.AUTH_DEV_LOGIN_ENABLED;
  });

  // ─── loginDev ─────────────────────────────────────────────────────────────

  describe('loginDev', () => {
    beforeEach(() => {
      // Ensure dev login is enabled by default in tests
      process.env.AUTH_DEV_LOGIN_ENABLED = 'true';
    });

    it('powinno zalogować użytkownika i zwrócić tokeny', async () => {
      const result = await service.loginDev({
        displayName: 'Test User',
        email: 'test@example.com',
      });

      expect(result).toHaveProperty('accessToken', 'mock-access-token');
      expect(result).toHaveProperty('refreshToken');
      expect(result.user).toMatchObject({
        id: mockUser.id,
        displayName: mockUser.displayName,
        email: mockUser.email,
      });
      expect(result.household).toBeNull();
    });

    it('powinno upsertować użytkownika z unikalnym googleId dev:', async () => {
      await service.loginDev({ displayName: 'Jan Kowalski', email: 'jan@example.com' });

      expect(prisma.user.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { googleId: 'dev:jan@example.com' },
          create: expect.objectContaining({ displayName: 'Jan Kowalski' }),
          update: expect.objectContaining({ displayName: 'Jan Kowalski' }),
        }),
      );
    });

    it('powinno odrzucić gdy brak displayName', async () => {
      await expect(service.loginDev({ displayName: '', email: null })).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.loginDev({ displayName: '   ', email: null })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('powinno odrzucić gdy AUTH_DEV_LOGIN_ENABLED=false', async () => {
      process.env.AUTH_DEV_LOGIN_ENABLED = 'false';
      await expect(service.loginDev({ displayName: 'Test', email: null })).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('powinno zwrócić household jeśli użytkownik należy do jednego', async () => {
      const mockHousehold = { id: 'hh-1', name: 'Dom' };
      prisma.membership.findFirst.mockResolvedValue({
        userId: mockUser.id,
        household: mockHousehold,
        createdAt: new Date(),
      });

      const result = await service.loginDev({ displayName: 'Test User', email: null });
      expect(result.household).toEqual({ id: 'hh-1', name: 'Dom' });
    });

    it('powinno trimować displayName', async () => {
      await service.loginDev({ displayName: '  Jan  ', email: null });

      expect(prisma.user.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ displayName: 'Jan' }),
        }),
      );
    });
  });

  // ─── loginWithGoogle ───────────────────────────────────────────────────────

  describe('loginWithGoogle', () => {
    it('powinno zalogować użytkownika Google i zwrócić tokeny', async () => {
      const result = await service.loginWithGoogle({
        googleId: 'google-123',
        displayName: 'Google User',
        email: 'google@example.com',
        avatarUrl: 'https://example.com/avatar.jpg',
      });

      expect(result).toHaveProperty('accessToken', 'mock-access-token');
      expect(result).toHaveProperty('refreshToken');
    });

    it('powinno odrzucić gdy brak googleId', async () => {
      await expect(
        service.loginWithGoogle({ googleId: '', displayName: 'Test', email: null, avatarUrl: null }),
      ).rejects.toThrow(BadRequestException);
    });

    it('powinno odrzucić gdy brak displayName', async () => {
      await expect(
        service.loginWithGoogle({ googleId: 'g-123', displayName: '', email: null, avatarUrl: null }),
      ).rejects.toThrow(BadRequestException);
    });

    it('powinno upsertować użytkownika po googleId', async () => {
      await service.loginWithGoogle({
        googleId: 'g-abc',
        displayName: 'New Name',
        email: 'new@example.com',
        avatarUrl: null,
      });

      expect(prisma.user.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { googleId: 'g-abc' },
          update: expect.objectContaining({ displayName: 'New Name' }),
        }),
      );
    });
  });

  // ─── refreshAccessToken ───────────────────────────────────────────────────

  describe('refreshAccessToken', () => {
    it('powinno wydać nowy access token i nowy refresh token', async () => {
      const result = await service.refreshAccessToken('valid-refresh-token');

      expect(result).toHaveProperty('accessToken', 'mock-access-token');
      expect(result).toHaveProperty('refreshToken');
      // Stary token powinien zostać unieważniony
      expect(prisma.refreshToken.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ revokedAt: expect.any(Date) }),
        }),
      );
    });

    it('powinno odrzucić nieistniejący token', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(null);

      await expect(service.refreshAccessToken('invalid-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('powinno odrzucić unieważniony token', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        ...mockRefreshToken,
        revokedAt: new Date(Date.now() - 1000),
      });

      await expect(service.refreshAccessToken('revoked-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('powinno odrzucić wygasły token', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        ...mockRefreshToken,
        expiresAt: new Date(Date.now() - 1000), // wygasł sekundę temu
        revokedAt: null,
      });

      await expect(service.refreshAccessToken('expired-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  // ─── issueAccessToken ─────────────────────────────────────────────────────

  describe('issueAccessToken', () => {
    it('powinno wywołać JwtService.signAsync z userId jako sub', async () => {
      const token = await service.issueAccessToken('user-xyz');

      expect(jwt.signAsync).toHaveBeenCalledWith(
        { sub: 'user-xyz' },
        expect.objectContaining({ expiresIn: expect.anything() }),
      );
      expect(token).toBe('mock-access-token');
    });
  });
});
