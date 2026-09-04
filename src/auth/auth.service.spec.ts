import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { AuthProvider } from '@prisma/client';
import { AuthService } from './auth.service';
import {
  AppleIdentityService,
  VerifiedAppleIdentity,
} from './apple-identity.service';
import { PrismaService } from '../prisma/prisma.service';

// ─── Mock factories ────────────────────────────────────────────────────────────

const mockUser = {
  id: 'user-123',
  googleId: 'dev:testuser',
  appleSub: null,
  authProvider: AuthProvider.DEV,
  displayName: 'Test User',
  email: 'test@example.com',
  emailVerified: false,
  avatarUrl: null,
  avatarColor: null,
  yearOfBirth: null,
  heightCm: null,
  weightKg: null,
  onboardingCompletedAt: null,
  lastLoginAt: new Date(),
};

const mockAppleUser = {
  id: 'user-apple-1',
  googleId: null,
  appleSub: '000111.abcdef.2222',
  authProvider: AuthProvider.APPLE,
  displayName: 'Rafał Piechowicz',
  email: 'rafal@example.com',
  emailVerified: true,
  avatarUrl: null,
  avatarColor: null,
  yearOfBirth: null,
  heightCm: null,
  weightKg: null,
  onboardingCompletedAt: null,
  lastLoginAt: new Date(),
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
    findUnique: jest.fn().mockResolvedValue(null),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    create: jest.fn().mockResolvedValue(mockAppleUser),
    update: jest.fn().mockResolvedValue(mockAppleUser),
  },
  refreshToken: {
    create: jest.fn().mockResolvedValue(mockRefreshToken),
    findUnique: jest.fn().mockResolvedValue(mockRefreshToken),
    update: jest
      .fn()
      .mockResolvedValue({ ...mockRefreshToken, revokedAt: new Date() }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
  membership: {
    findFirst: jest.fn().mockResolvedValue(null),
  },
});

const makeJwtMock = () => ({
  signAsync: jest.fn().mockResolvedValue('mock-access-token'),
});

const makeAppleMock = () => ({
  verify: jest.fn<Promise<VerifiedAppleIdentity>, [string, string]>(),
  hashNonce: jest.fn((n: string) => `hash:${n}`),
});

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('AuthService', () => {
  let service: AuthService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let jwt: ReturnType<typeof makeJwtMock>;
  let apple: ReturnType<typeof makeAppleMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    jwt = makeJwtMock();
    apple = makeAppleMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwt },
        { provide: AppleIdentityService, useValue: apple },
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
        provider: AuthProvider.DEV,
      });
      expect(result.household).toBeNull();
    });

    it('powinno upsertować użytkownika z unikalnym googleId dev:', async () => {
      await service.loginDev({
        displayName: 'Jan Kowalski',
        email: 'jan@example.com',
      });

      expect(prisma.user.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { googleId: 'dev:jan@example.com' },
          create: expect.objectContaining({
            displayName: 'Jan Kowalski',
            authProvider: AuthProvider.DEV,
          }),
          update: expect.objectContaining({
            displayName: 'Jan Kowalski',
            authProvider: AuthProvider.DEV,
          }),
        }),
      );
    });

    it('powinno odrzucić gdy brak displayName', async () => {
      await expect(
        service.loginDev({ displayName: '', email: undefined }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.loginDev({ displayName: '   ', email: undefined }),
      ).rejects.toThrow(BadRequestException);
    });

    it('powinno odrzucić gdy AUTH_DEV_LOGIN_ENABLED=false', async () => {
      process.env.AUTH_DEV_LOGIN_ENABLED = 'false';
      await expect(
        service.loginDev({ displayName: 'Test', email: undefined }),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'DEV_LOGIN_DISABLED' },
      });
    });

    it.each([
      ['nieustawione', undefined],
      ['pusty string', ''],
      ['TRUE wielkimi literami', 'TRUE'],
      ['1', '1'],
    ])(
      'powinno odrzucić, gdy AUTH_DEV_LOGIN_ENABLED to %s (opt-in, nie opt-out)',
      async (_label, value) => {
        if (value === undefined) {
          delete process.env.AUTH_DEV_LOGIN_ENABLED;
        } else {
          process.env.AUTH_DEV_LOGIN_ENABLED = value;
        }
        await expect(
          service.loginDev({ displayName: 'Test', email: undefined }),
        ).rejects.toMatchObject({
          status: 403,
          response: { code: 'DEV_LOGIN_DISABLED' },
        });
      },
    );

    it('powinno zwrócić household jeśli użytkownik należy do jednego', async () => {
      const mockHousehold = { id: 'hh-1', name: 'Dom' };
      prisma.membership.findFirst.mockResolvedValue({
        userId: mockUser.id,
        household: mockHousehold,
        createdAt: new Date(),
      });

      const result = await service.loginDev({
        displayName: 'Test User',
        email: undefined,
      });
      expect(result.household).toEqual({ id: 'hh-1', name: 'Dom' });
    });

    it('powinno trimować displayName', async () => {
      await service.loginDev({ displayName: '  Jan  ', email: undefined });

      expect(prisma.user.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ displayName: 'Jan' }),
        }),
      );
    });
  });

  // ─── wycofane logowanie Google ────────────────────────────────────────────
  //
  // `POST /auth/google` wybijał pełną sesję każdemu, kto podał dowolny
  // `googleId` — bez weryfikacji tokenu. iOS nigdy z niego nie korzystał.

  it('loginWithGoogle nie istnieje już w serwisie', () => {
    expect(
      (service as unknown as Record<string, unknown>).loginWithGoogle,
    ).toBeUndefined();
  });

  // ─── loginWithApple ───────────────────────────────────────────────────────

  describe('loginWithApple', () => {
    const verified: VerifiedAppleIdentity = {
      appleSub: '000111.abcdef.2222',
      email: 'rafal@example.com',
      emailVerified: true,
      issuedAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      audience: 'app.scoffie.ios',
    };

    it('powinno odrzucić gdy brak identityToken', async () => {
      await expect(
        service.loginWithApple({
          identityToken: '',
          rawNonce: 'nonce-value',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('powinno odrzucić gdy brak rawNonce', async () => {
      await expect(
        service.loginWithApple({
          identityToken: 'eyJ...',
          rawNonce: '',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('powinno utworzyć nowego użytkownika gdy Apple sub nie istnieje', async () => {
      apple.verify.mockResolvedValue(verified);
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(mockAppleUser);

      const result = await service.loginWithApple({
        identityToken: 'eyJ.valid.token',
        rawNonce: 'raw-nonce',
        givenName: 'Rafał',
        familyName: 'Piechowicz',
      });

      expect(apple.verify).toHaveBeenCalledWith('eyJ.valid.token', 'raw-nonce');
      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            appleSub: verified.appleSub,
            authProvider: AuthProvider.APPLE,
            displayName: 'Rafał Piechowicz',
            email: 'rafal@example.com',
            emailVerified: true,
          }),
        }),
      );
      expect(result.user).toMatchObject({
        id: mockAppleUser.id,
        displayName: mockAppleUser.displayName,
        email: mockAppleUser.email,
        provider: AuthProvider.APPLE,
      });
    });

    it('powinno użyć fallback displayName jeśli Apple nie podał imienia', async () => {
      apple.verify.mockResolvedValue({
        ...verified,
        email: 'anon@example.com',
      });
      prisma.user.findUnique.mockResolvedValue(null);

      await service.loginWithApple({
        identityToken: 'eyJ.valid.token',
        rawNonce: 'raw-nonce',
      });

      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            displayName: 'anon', // email local-part fallback
          }),
        }),
      );
    });

    it('powinno nadpisać placeholder displayName gdy Apple wreszcie przysyła prawdziwe imię', async () => {
      apple.verify.mockResolvedValue(verified);
      prisma.user.findUnique.mockResolvedValue({
        ...mockAppleUser,
        displayName: 'rafal', // placeholder (lowercase local part)
      });

      await service.loginWithApple({
        identityToken: 'eyJ.valid.token',
        rawNonce: 'raw-nonce',
        givenName: 'Rafał',
        familyName: 'Piechowicz',
      });

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { appleSub: verified.appleSub },
          data: expect.objectContaining({
            displayName: 'Rafał Piechowicz',
            authProvider: AuthProvider.APPLE,
          }),
        }),
      );
    });

    it('nie powinno nadpisywać dobrego displayName gdy Apple nie dostarcza nowego', async () => {
      apple.verify.mockResolvedValue(verified);
      prisma.user.findUnique.mockResolvedValue({
        ...mockAppleUser,
        displayName: 'Rafał Piechowicz',
      });

      await service.loginWithApple({
        identityToken: 'eyJ.valid.token',
        rawNonce: 'raw-nonce',
      });

      const updateCall = prisma.user.update.mock.calls[0][0];
      expect(updateCall.data).not.toHaveProperty('displayName');
    });

    it('powinno propagować UnauthorizedException z AppleIdentityService', async () => {
      apple.verify.mockRejectedValue(
        new UnauthorizedException('Invalid Apple identity token.'),
      );

      await expect(
        service.loginWithApple({
          identityToken: 'eyJ.bad.token',
          rawNonce: 'raw-nonce',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  // ─── refreshAccessToken ───────────────────────────────────────────────────

  describe('refreshAccessToken', () => {
    it('powinno wydać nowy access token i nowy refresh token', async () => {
      const result = await service.refreshAccessToken('valid-refresh-token');

      expect(result).toHaveProperty('accessToken', 'mock-access-token');
      expect(result).toHaveProperty('refreshToken');
      // Rotacja jest warunkowa (revokedAt: null) — patrz test wyścigu niżej.
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { tokenHash: expect.any(String), revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('przegrany wyścig o rotację (updateMany → 0) to replay: rodzina unieważniona, 401', async () => {
      prisma.refreshToken.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 2 });

      await expect(service.refreshAccessToken('raced-token')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.updateMany).toHaveBeenNthCalledWith(2, {
        where: { userId: mockRefreshToken.userId, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(jwt.signAsync).not.toHaveBeenCalled();
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('powinno odrzucić nieistniejący token', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(null);

      await expect(service.refreshAccessToken('invalid-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('powinno odrzucić unieważniony token i unieważnić całą rodzinę usera (reuse-detection)', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        ...mockRefreshToken,
        revokedAt: new Date(Date.now() - 1000),
      });

      await expect(service.refreshAccessToken('revoked-token')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: mockRefreshToken.userId, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      // Rodzina refresh tokenów pada RAZEM z tokenami dostępu — podbicie wersji.
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: mockRefreshToken.userId },
        data: { tokenVersion: { increment: 1 } },
      });
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledTimes(1);
      expect(jwt.signAsync).not.toHaveBeenCalled();
    });

    it('udana rotacja sprząta wygasłe tokeny usera', async () => {
      await service.refreshAccessToken('valid-refresh-token');

      expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({
        where: {
          userId: mockRefreshToken.userId,
          expiresAt: { lt: expect.any(Date) },
        },
      });
    });

    it('powinno odrzucić wygasły token', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        ...mockRefreshToken,
        expiresAt: new Date(Date.now() - 1000),
        revokedAt: null,
      });

      await expect(service.refreshAccessToken('expired-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  // ─── logout ──────────────────────────────────────────────────────────────

  describe('logout', () => {
    it('unieważnia podany refresh token i mówi, czy coś unieważnił', async () => {
      prisma.refreshToken.updateMany.mockResolvedValueOnce({ count: 1 });
      await expect(service.logout('raw-refresh')).resolves.toEqual({
        revoked: true,
      });
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { tokenHash: expect.any(String), revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('jest idempotentny — drugi logout tym samym tokenem to revoked=false, bez błędu', async () => {
      prisma.refreshToken.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.logout('raw-refresh')).resolves.toEqual({
        revoked: false,
      });
    });
  });

  // ─── issueAccessToken ─────────────────────────────────────────────────────

  describe('issueAccessToken', () => {
    it('powinno wywołać JwtService.signAsync z userId jako sub', async () => {
      const token = await service.issueAccessToken('user-xyz');

      expect(jwt.signAsync).toHaveBeenCalledWith(
        { sub: 'user-xyz', tv: 0 },
        expect.objectContaining({ expiresIn: expect.anything() }),
      );
      expect(token).toBe('mock-access-token');
    });
  });
});
