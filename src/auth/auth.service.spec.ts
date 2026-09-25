import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import {
  BadRequestException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthProvider, Prisma } from '@prisma/client';
import { AuthService } from './auth.service';
import {
  AppleIdentityService,
  VerifiedAppleIdentity,
} from './apple-identity.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  GoogleIdentityService,
  VerifiedGoogleIdentity,
} from './google-identity.service';
import { AppException } from '../common/app-exception';
import { purchaseIdentityHash } from '../config/purchase-identity';

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

const makePrismaMock = () => {
  const prisma = {
    user: {
      upsert: jest.fn().mockResolvedValue(mockUser),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
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
    // Transakcja interaktywna: bez bazy nie ma czego izolować, więc callback
    // dostaje ten sam mock. Testy patrzą na to, CO poszło w jednym zapytaniu.
    $transaction: jest.fn(),
    // Zamek sesji (`lockUserSessions`, SELECT … FOR NO KEY UPDATE).
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  prisma.$transaction.mockImplementation(
    (run: (tx: typeof prisma) => unknown) => run(prisma),
  );
  return prisma;
};

const makeGoogleMock = () => ({
  assertEnabled: jest.fn(() => ['test.apps.googleusercontent.com']),
  verify: jest.fn<
    Promise<VerifiedGoogleIdentity>,
    [string, (string | null)?]
  >(),
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
  let google: ReturnType<typeof makeGoogleMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    jwt = makeJwtMock();
    apple = makeAppleMock();
    google = makeGoogleMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwt },
        { provide: AppleIdentityService, useValue: apple },
        { provide: GoogleIdentityService, useValue: google },
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

  // ─── dawne logowanie Google (wycofane w F2) ───────────────────────────────
  //
  // Stary `POST /auth/google` wybijał pełną sesję każdemu, kto podał dowolny
  // `googleId` — bez weryfikacji tokenu. Nowy (25.09.2026) bierze tożsamość
  // WYŁĄCZNIE z ID tokenu zweryfikowanego przez Google; to przypina ten test.

  it('loginWithGoogle nie ufa niczemu z ciała poza tokenem do weryfikacji', async () => {
    google.verify.mockRejectedValue(
      new AppException('APPLE_IDENTITY_INVALID', 'Invalid', 401),
    );
    await expect(
      service.loginWithGoogle({
        idToken: 'podrobiony.token.x',
        googleId: '109876543210',
        email: 'ofiara@example.com',
      } as unknown as Parameters<AuthService['loginWithGoogle']>[0]),
    ).rejects.toMatchObject({ code: 'APPLE_IDENTITY_INVALID' });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
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

    describe('adres e-mail: tylko z podpisanego tokenu, nigdy z DTO', () => {
      const ATAKOWANY = 'ofiara@cudza-firma.pl';
      let warn: jest.SpyInstance;

      beforeEach(() => {
        warn = jest
          .spyOn(Logger.prototype, 'warn')
          .mockImplementation(() => undefined);
      });
      afterEach(() => warn.mockRestore());

      it('poprawny token + zgodny e-mail w DTO: zapis z tokenu, bez ostrzeżenia', async () => {
        apple.verify.mockResolvedValue(verified);
        prisma.user.findUnique.mockResolvedValue(null);
        prisma.user.create.mockResolvedValue(mockAppleUser);

        await service.loginWithApple({
          identityToken: 'eyJ.valid.token',
          rawNonce: 'raw-nonce',
          // Wielkość liter i spacje nie robią z tego rozjazdu.
          email: '  Rafal@Example.com ',
        });

        const data = prisma.user.create.mock.calls[0][0].data;
        expect(data.email).toBe('rafal@example.com');
        expect(data.emailVerified).toBe(true);
        expect(warn).not.toHaveBeenCalled();
      });

      it('nowe konto, e-mail w DTO podmieniony: do bazy idzie adres z tokenu', async () => {
        apple.verify.mockResolvedValue(verified);
        prisma.user.findUnique.mockResolvedValue(null);
        prisma.user.create.mockResolvedValue(mockAppleUser);

        await service.loginWithApple({
          identityToken: 'eyJ.valid.token',
          rawNonce: 'raw-nonce',
          email: ATAKOWANY,
        });

        const data = prisma.user.create.mock.calls[0][0].data;
        expect(data.email).toBe('rafal@example.com');
        expect(JSON.stringify(data)).not.toContain(ATAKOWANY);
        // Rozjazd jest odnotowany, ale BEZ żadnego z adresów w logu.
        expect(warn).toHaveBeenCalledTimes(1);
        const line = String(warn.mock.calls[0][0]);
        expect(line).not.toContain(ATAKOWANY);
        expect(line).not.toContain('rafal@example.com');
      });

      it('token BEZ claimu email + e-mail w DTO: konto powstaje bez adresu i bez „verified”', async () => {
        // Najgorszy wariant: token twierdzi `email_verified`, ale adresu nie
        // niesie — dawniej to potwierdzenie przyklejało się do adresu z DTO.
        apple.verify.mockResolvedValue({
          ...verified,
          email: null,
          emailVerified: true,
        });
        prisma.user.findUnique.mockResolvedValue(null);
        prisma.user.create.mockResolvedValue({ ...mockAppleUser, email: null });

        await service.loginWithApple({
          identityToken: 'eyJ.valid.token',
          rawNonce: 'raw-nonce',
          email: ATAKOWANY,
        });

        const data = prisma.user.create.mock.calls[0][0].data;
        expect(data.email).toBeNull();
        expect(data.emailVerified).toBe(false);
        // Nazwa zastępcza też nie bierze się z cudzego adresu.
        expect(data.displayName).toBe(`Apple-${verified.appleSub.slice(0, 8)}`);
      });

      it('istniejące konto: podmieniony e-mail w DTO nie rusza adresu ani `emailVerified`', async () => {
        apple.verify.mockResolvedValue({
          ...verified,
          email: null,
          emailVerified: true,
        });
        prisma.user.findUnique.mockResolvedValue({
          ...mockAppleUser,
          email: ATAKOWANY,
          emailVerified: false,
        });

        await service.loginWithApple({
          identityToken: 'eyJ.valid.token',
          rawNonce: 'raw-nonce',
          // Zgodny z bazą, ale token go nie potwierdza.
          email: ATAKOWANY,
        });

        const data = prisma.user.update.mock.calls[0][0].data;
        expect(data).not.toHaveProperty('email');
        expect(data).not.toHaveProperty('emailVerified');
      });

      it('istniejące konto: nowy adres z tokenu wygrywa z tym z DTO', async () => {
        apple.verify.mockResolvedValue({
          ...verified,
          email: 'nowy@example.com',
        });
        prisma.user.findUnique.mockResolvedValue(mockAppleUser);

        await service.loginWithApple({
          identityToken: 'eyJ.valid.token',
          rawNonce: 'raw-nonce',
          email: ATAKOWANY,
        });

        const data = prisma.user.update.mock.calls[0][0].data;
        expect(data.email).toBe('nowy@example.com');
        expect(data.emailVerified).toBe(true);
      });

      it('log o nowym koncie nie niesie adresu ani `sub` Apple', async () => {
        const log = jest
          .spyOn(Logger.prototype, 'log')
          .mockImplementation(() => undefined);
        apple.verify.mockResolvedValue(verified);
        prisma.user.findUnique.mockResolvedValue(null);
        prisma.user.create.mockResolvedValue(mockAppleUser);

        await service.loginWithApple({
          identityToken: 'eyJ.valid.token',
          rawNonce: 'raw-nonce',
        });

        const lines = log.mock.calls.map((call) => String(call[0])).join('\n');
        expect(lines).toContain(mockAppleUser.id);
        expect(lines).not.toContain('rafal@example.com');
        expect(lines).not.toContain(verified.appleSub.slice(0, 8));
        log.mockRestore();
      });
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

  // ─── loginWithGoogle ──────────────────────────────────────────────────────

  describe('loginWithGoogle', () => {
    const verifiedGoogle = (
      overrides: Partial<VerifiedGoogleIdentity> = {},
    ): VerifiedGoogleIdentity => ({
      googleSub: '109876543210',
      email: 'rafal@example.com',
      emailVerified: true,
      name: 'Rafał Google',
      givenName: 'Rafał',
      familyName: 'Google',
      picture: 'https://lh3.googleusercontent.com/a/x',
      ...overrides,
    });
    const googleUser = {
      ...mockAppleUser,
      id: 'user-google-1',
      appleSub: null,
      googleId: '109876543210',
      authProvider: AuthProvider.GOOGLE,
      identityHash: null,
    };

    it('nowy użytkownik: konto GOOGLE z profilem z tokenu, identityHash z GOOGLE:sub', async () => {
      google.verify.mockResolvedValue(verifiedGoogle());
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.create.mockResolvedValue(googleUser);

      const result = await service.loginWithGoogle({
        idToken: 'google.id.token',
        nonce: 'nonce-12345678',
        platform: 'android',
      });

      expect(google.verify).toHaveBeenCalledWith(
        'google.id.token',
        'nonce-12345678',
      );
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          googleId: '109876543210',
          authProvider: AuthProvider.GOOGLE,
          email: 'rafal@example.com',
          emailVerified: true,
          displayName: 'Rafał Google',
          avatarUrl: 'https://lh3.googleusercontent.com/a/x',
        }),
      });
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: 'user-google-1', identityHash: null },
        data: {
          identityHash: purchaseIdentityHash('GOOGLE', '109876543210'),
        },
      });
      // Ta sama koperta co /auth/apple.
      expect(Object.keys(result).sort()).toEqual(
        ['accessToken', 'household', 'refreshToken', 'user'].sort(),
      );
      expect(result.user).toMatchObject({
        id: 'user-google-1',
        provider: AuthProvider.GOOGLE,
      });
      expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
    });

    it('istniejący po googleId: bez łączenia i bez zakładania, provider bez zmian', async () => {
      google.verify.mockResolvedValue(verifiedGoogle());
      prisma.user.findUnique.mockResolvedValueOnce(googleUser);
      prisma.user.update.mockResolvedValue(googleUser);

      await service.loginWithGoogle({ idToken: 'google.id.token' });

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { googleId: '109876543210' },
      });
      expect(prisma.user.findMany).not.toHaveBeenCalled();
      expect(prisma.user.create).not.toHaveBeenCalled();
      const data = prisma.user.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('authProvider');
      expect(data).toHaveProperty('lastLoginAt');
    });

    it('konto Apple zalogowane Google: adres Apple nie jest nadpisywany', async () => {
      const linkedApple = {
        ...mockAppleUser,
        googleId: '109876543210',
        email: 'apple@example.com',
      };
      google.verify.mockResolvedValue(verifiedGoogle());
      prisma.user.findUnique.mockResolvedValueOnce(linkedApple);
      prisma.user.update.mockResolvedValue(linkedApple);

      await service.loginWithGoogle({ idToken: 'google.id.token' });

      const data = prisma.user.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('email');
      expect(data).not.toHaveProperty('emailVerified');
      expect(data).not.toHaveProperty('authProvider');
    });

    it('łączenie po adresie: potwierdzony w Google i w koncie → dopisany googleId, reszta konta nietknięta', async () => {
      google.verify.mockResolvedValue(verifiedGoogle());
      prisma.user.findUnique
        .mockResolvedValueOnce(null) // po googleId
        .mockResolvedValueOnce({
          ...mockAppleUser,
          googleId: '109876543210',
          identityHash: 'hash-apple',
        }); // po id, po dopisaniu
      prisma.user.findMany.mockResolvedValue([{ id: mockAppleUser.id }]);
      prisma.user.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.loginWithGoogle({ idToken: 'tok.en.x' });

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            email: { equals: 'rafal@example.com', mode: 'insensitive' },
            emailVerified: true,
            googleId: null,
          },
        }),
      );
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: mockAppleUser.id, googleId: null, emailVerified: true },
        data: { googleId: '109876543210', lastLoginAt: expect.any(Date) },
      });
      // Wyłącznie googleId i lastLoginAt — bez authProvider, appleSub, identityHash.
      const linkData = prisma.user.updateMany.mock.calls[0][0].data as object;
      expect(Object.keys(linkData).sort()).toEqual(['googleId', 'lastLoginAt']);
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(result.user).toMatchObject({
        id: mockAppleUser.id,
        provider: AuthProvider.APPLE,
      });
      // identityHash już był — ensurePurchaseIdentity niczego nie przelicza.
      expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    });

    it('brak łączenia, gdy Google nie potwierdza adresu (email_verified=false)', async () => {
      google.verify.mockResolvedValue(verifiedGoogle({ emailVerified: false }));
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(googleUser);

      await service.loginWithGoogle({ idToken: 'tok.en.x' });

      expect(prisma.user.findMany).not.toHaveBeenCalled();
      expect(prisma.user.create).toHaveBeenCalled();
    });

    it('brak łączenia z kontem o niepotwierdzonym albo innym adresie → nowe konto', async () => {
      google.verify.mockResolvedValue(verifiedGoogle());
      prisma.user.findUnique.mockResolvedValue(null);
      // Zapytanie żąda emailVerified: true i równego adresu — konto
      // niepotwierdzone albo z innym adresem nie wraca.
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.create.mockResolvedValue(googleUser);

      const result = await service.loginWithGoogle({ idToken: 'tok.en.x' });

      const linkCalls = prisma.user.updateMany.mock.calls.filter(
        ([args]) => 'googleId' in (args.data as object),
      );
      expect(linkCalls).toHaveLength(0);
      expect(prisma.user.create).toHaveBeenCalled();
      expect(result.user.id).toBe('user-google-1');
    });

    it('dwa potwierdzone konta z tym adresem → nie zgadujemy, nowe konto', async () => {
      google.verify.mockResolvedValue(verifiedGoogle());
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
      prisma.user.create.mockResolvedValue(googleUser);

      await service.loginWithGoogle({ idToken: 'tok.en.x' });

      expect(prisma.user.create).toHaveBeenCalled();
    });

    it('wyścig dwóch pierwszych logowań: P2002 na googleId → konto zwycięzcy', async () => {
      google.verify.mockResolvedValue(verifiedGoogle({ emailVerified: false }));
      prisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(googleUser);
      prisma.user.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      prisma.user.update.mockResolvedValue(googleUser);

      const result = await service.loginWithGoogle({ idToken: 'tok.en.x' });

      expect(result.user.id).toBe('user-google-1');
    });

    it('zły token (aud, nonce, podpis) → błąd weryfikatora przechodzi bez zapisu', async () => {
      google.verify.mockRejectedValue(
        new AppException('APPLE_IDENTITY_INVALID', 'Invalid', 401),
      );

      await expect(
        service.loginWithGoogle({ idToken: 'tok.en.x', nonce: 'zly-nonce-1' }),
      ).rejects.toMatchObject({ code: 'APPLE_IDENTITY_INVALID' });
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('brak env → 503 zanim cokolwiek zostanie zweryfikowane', async () => {
      google.assertEnabled.mockImplementation(() => {
        throw new AppException('SERVICE_UNAVAILABLE', 'off', 503);
      });

      await expect(
        service.loginWithGoogle({ idToken: 'tok.en.x' }),
      ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      expect(google.verify).not.toHaveBeenCalled();
    });
  });

  describe('refreshAccessToken', () => {
    it('powinno wydać nowy access token i nowy refresh token', async () => {
      const result = await service.refreshAccessToken('valid-refresh-token');

      expect(result).toHaveProperty('accessToken', 'mock-access-token');
      expect(result).toHaveProperty('refreshToken');
      // JEDNO zapytanie: unieważnienie warunkowe (revokedAt: null — patrz test
      // wyścigu niżej) RAZEM ze wskaźnikiem na następcę. Rozbicie tego na dwa
      // zapytania zostawiało między nimi wiersz z ROTATED bez następcy, a w
      // tym oknie `recoverLostRotation` nie ma po czym poznać zgubionej
      // odpowiedzi i kasuje całą rodzinę (prod, 11.09.2026).
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { tokenHash: expect.any(String), revokedAt: null },
        data: {
          revokedAt: expect.any(Date),
          revokedReason: 'ROTATED',
          replacedByHash: expect.any(String),
        },
      });
      // Następca powstaje w tej samej transakcji, więc wskaźnik nigdy nie
      // wskazuje na wiersz, którego jeszcze nie ma.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.refreshToken.create).toHaveBeenCalledWith({
        data: {
          tokenHash: expect.any(String),
          userId: mockRefreshToken.userId,
          expiresAt: expect.any(Date),
        },
      });
    });

    // ─── wyścig dwóch żądań tym samym tokenem ────────────────────────────
    //
    // Telefon ma single-flight, ale POST i tak potrafi pójść dwa razy: gdy
    // połączenie padnie przed odpowiedzią, URLSession ponawia żądanie. Serwer
    // widzi wtedy dwa refreshe tym samym tokenem w tej samej sekundzie.

    it('przegrany wyścig o rotację to ponowiony POST, nie kradzież: ratunek zamiast kasowania rodziny', async () => {
      // Zwycięzca zdążył zatwierdzić transakcję, więc warunkowy UPDATE
      // przegranego trafia w 0 wierszy, a ponowny odczyt widzi już komplet.
      prisma.refreshToken.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.refreshToken.findUnique
        .mockResolvedValueOnce(mockRefreshToken)
        .mockResolvedValueOnce({
          ...mockRefreshToken,
          revokedAt: new Date(),
          revokedReason: 'ROTATED',
          replacedByHash: 'hash-nastepcy',
        })
        // Ten sam wiersz czytany drugi raz, pod zamkiem sesji (`lockUserSessions`).
        .mockResolvedValueOnce({
          ...mockRefreshToken,
          revokedAt: new Date(),
          revokedReason: 'ROTATED',
          replacedByHash: 'hash-nastepcy',
        })
        // Odczyt następcy: żyje, więc para mogła nie dojechać.
        .mockResolvedValueOnce({ revokedAt: null });

      const result = await service.refreshAccessToken('ponowiony-token');

      expect(result).toHaveProperty('accessToken', 'mock-access-token');
      expect(result).toHaveProperty('refreshToken');
      // Rodzina żyje, tokeny dostępu zostają ważne.
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
      // Ślad idzie na PRZEDSTAWIONYM tokenie, nie na następcy.
      expect(prisma.refreshToken.updateMany).toHaveBeenNthCalledWith(2, {
        where: {
          tokenHash: mockRefreshToken.tokenHash,
          revokedReason: { in: ['ROTATED', 'RECOVERED'] },
        },
        data: { revokedReason: 'RECOVERED' },
      });
    });

    it('przegrany wyścig na tokenie po WYLOGOWANIU: 401, ale rodzina żyje', async () => {
      prisma.refreshToken.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.refreshToken.findUnique
        .mockResolvedValueOnce(mockRefreshToken)
        .mockResolvedValueOnce({
          ...mockRefreshToken,
          revokedAt: new Date(),
          revokedReason: 'LOGOUT',
          replacedByHash: null,
        })
        // Ten sam wiersz czytany drugi raz, pod zamkiem sesji (`lockUserSessions`).
        .mockResolvedValueOnce({
          ...mockRefreshToken,
          revokedAt: new Date(),
          revokedReason: 'LOGOUT',
          replacedByHash: null,
        });

      await expect(service.refreshAccessToken('raced-token')).rejects.toThrow(
        UnauthorizedException,
      );
      // Wylogowanie to nie kradzież: ponowiony POST z wylogowanym tokenem ma
      // dostać 401 i nic więcej. Dotąd zabierał ze sobą drugie urządzenie
      // (kasowanie rodziny + podbicie `tokenVersion`, czyli także tokeny dostępu).
      expect(jwt.signAsync).not.toHaveBeenCalled();
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('powinno odrzucić nieistniejący token', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(null);

      await expect(service.refreshAccessToken('invalid-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('unieważniony token BEZ powodu (wiersz sprzed migracji) to 401 — bez kasowania rodziny', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        ...mockRefreshToken,
        revokedAt: new Date(Date.now() - 1000),
      });

      await expect(service.refreshAccessToken('revoked-token')).rejects.toThrow(
        UnauthorizedException,
      );
      // `revokedReason: null` mają wyłącznie wiersze sprzed migracji, która tę
      // kolumnę dodała — dzisiaj każde unieważnienie pisze powód. Brak powodu
      // nie jest więc dowodem kopii, tylko brakiem danych, a kara za kradzież
      // (wylogowanie ze WSZYSTKICH urządzeń) wymaga dowodu.
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
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

    // ─── zgubiona odpowiedź z rotacji ────────────────────────────────────
    //
    // Telefon wysłał refresh, serwer zrotował token, iOS uśpił proces i
    // odpowiedź nie dojechała. W Keychain został STARY token. Bez okna łaski
    // następne uruchomienie wyglądało jak kradzież i kończyło się
    // wylogowaniem („Sesja wygasła”) mimo że użytkownik nic nie zrobił.

    it('zgubiona odpowiedź z rotacji: nietknięty następca w oknie łaski → świeża para, rodzina żyje', async () => {
      prisma.refreshToken.findUnique
        .mockResolvedValueOnce({
          ...mockRefreshToken,
          revokedAt: new Date(Date.now() - 5_000),
          revokedReason: 'ROTATED',
          replacedByHash: 'hash-nastepcy',
        })
        // Ten sam wiersz czytany drugi raz, pod zamkiem sesji (`lockUserSessions`).
        .mockResolvedValueOnce({
          ...mockRefreshToken,
          revokedAt: new Date(Date.now() - 5_000),
          revokedReason: 'ROTATED',
          replacedByHash: 'hash-nastepcy',
        })
        // Następca ŻYJE = nikt go nie użył.
        .mockResolvedValueOnce({ revokedAt: null });
      prisma.refreshToken.updateMany.mockResolvedValueOnce({ count: 1 });

      const result = await service.refreshAccessToken('stary-token');

      expect(result).toHaveProperty('accessToken', 'mock-access-token');
      expect(result).toHaveProperty('refreshToken');
      // Rodzina NIE pada i tokeny dostępu zostają ważne.
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
      // Ślad po ratunku zostaje na PRZEDSTAWIONYM tokenie. Granicę stawia czas
      // (okno łaski liczone od `revokedAt`, które się nie przesuwa), nie licznik
      // ratunków — telefon nie ma jak wiedzieć, które z jego ponowień serwer
      // już obsłużył.
      expect(prisma.refreshToken.updateMany).toHaveBeenNthCalledWith(1, {
        where: {
          tokenHash: mockRefreshToken.tokenHash,
          revokedReason: { in: ['ROTATED', 'RECOVERED'] },
        },
        data: { revokedReason: 'RECOVERED' },
      });
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledTimes(1);
    });

    // ─── PROD 13.09.2026: ratunek zabijał token, który klient właśnie dostał ──
    //
    // Zmierzone na produkcji. 12:26 rotacja (klient dostaje S_A) i w tej samej
    // sekundzie ratunek dla ponowionego POST-a, który kasował S_A jako REUSE
    // i wydawał S_B. Klient miał w Keychainie S_A, więc S_B oddał przez
    // /auth/logout — i został z tokenem, który serwer właśnie zabił. O 16:49,
    // gdy wygasł access token, S_A wrócił jako `reason=REUSE successor=missing`
    // i skończyło się wylogowaniem. Założenie „nieużyty = nie dotarł" jest
    // fałszywe: świeży refresh token leży u klienta nieużywany nawet godzinę.

    it('ratunek NIE unieważnia następcy — on może już leżeć u klienta', async () => {
      prisma.refreshToken.findUnique
        .mockResolvedValueOnce({
          ...mockRefreshToken,
          revokedAt: new Date(Date.now() - 5_000),
          revokedReason: 'ROTATED',
          replacedByHash: 'hash-nastepcy',
        })
        // Ten sam wiersz czytany drugi raz, pod zamkiem sesji (`lockUserSessions`).
        .mockResolvedValueOnce({
          ...mockRefreshToken,
          revokedAt: new Date(Date.now() - 5_000),
          revokedReason: 'ROTATED',
          replacedByHash: 'hash-nastepcy',
        })
        .mockResolvedValueOnce({ revokedAt: null });
      prisma.refreshToken.updateMany.mockResolvedValueOnce({ count: 1 });

      await service.refreshAccessToken('stary-token');

      // Następca jest tylko CZYTANY.
      expect(prisma.refreshToken.findUnique).toHaveBeenNthCalledWith(3, {
        where: { tokenHash: 'hash-nastepcy' },
        select: { revokedAt: true, revokedReason: true },
      });
      // I żaden zapis go nie dotyka — ani po `tokenHash`, ani przy okazji.
      for (const call of prisma.refreshToken.updateMany.mock.calls) {
        expect(call[0]?.where?.tokenHash).not.toBe('hash-nastepcy');
      }
      expect(prisma.refreshToken.update).not.toHaveBeenCalled();
    });

    it('token JUŻ raz uratowany (RECOVERED) ratuje się dalej w oknie łaski', async () => {
      prisma.refreshToken.findUnique
        .mockResolvedValueOnce({
          ...mockRefreshToken,
          revokedAt: new Date(Date.now() - 5_000),
          // Ponowienie numer trzy: rotację ratowaliśmy już wcześniej.
          revokedReason: 'RECOVERED',
          replacedByHash: 'hash-nastepcy',
        })
        // Ten sam wiersz czytany drugi raz, pod zamkiem sesji (`lockUserSessions`).
        .mockResolvedValueOnce({
          ...mockRefreshToken,
          revokedAt: new Date(Date.now() - 5_000),
          // Ponowienie numer trzy: rotację ratowaliśmy już wcześniej.
          revokedReason: 'RECOVERED',
          replacedByHash: 'hash-nastepcy',
        })
        .mockResolvedValueOnce({ revokedAt: null });
      prisma.refreshToken.updateMany.mockResolvedValueOnce({ count: 1 });

      // Zmierzone e2e: przy trzecim ponowieniu warunek „tylko ROTATED" kasował
      // rodzinę, czyli wylogowywał ze wszystkich urządzeń za słabą sieć.
      // URLSession ponawia POST tyle razy, ile trzeba, a nie raz.
      const result = await service.refreshAccessToken('stary-token');
      expect(result).toHaveProperty('refreshToken');
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('odmowa BEZ dowodu rozwidlenia nigdy nie podbija tokenVersion', async () => {
      // Wygasły, unieważniony token: nie ma czego ratować, ale też nie ma
      // dowodu kopii. Tokeny DOSTĘPU pozostałych urządzeń mają przeżyć.
      prisma.refreshToken.findUnique.mockResolvedValue({
        ...mockRefreshToken,
        revokedAt: new Date(Date.now() - 5_000),
        revokedReason: 'ROTATED',
        replacedByHash: 'hash-nastepcy',
        expiresAt: new Date(Date.now() - 1_000),
      });

      await expect(service.refreshAccessToken('wygasly')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    // Nazwa tego testu kłamała: mówiła „drugie powtórzenie już nie ratuje",
    // a tuż wyżej stoi test, w którym token RECOVERED ratuje się dalej.
    // Naprawdę sprawdzał co innego — `mockResolvedValue` (bez `Once`) oddaje
    // ten sam unieważniony wiersz także przy odczycie NASTĘPCY, czyli
    // rozwidlenie łańcucha. I to jest przypadek warty testu, tylko pod
    // własną nazwą.
    it('token po ratunku (RECOVERED) z UŻYTYM następcą → rodzina pada', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        ...mockRefreshToken,
        revokedAt: new Date(Date.now() - 5_000),
        revokedReason: 'RECOVERED',
        replacedByHash: 'hash-nastepcy',
      });

      await expect(service.refreshAccessToken('stary-token')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.user.updateMany).toHaveBeenCalled();
    });

    it('następca już użyty → to jednak replay: rodzina unieważniona, 401', async () => {
      prisma.refreshToken.findUnique
        .mockResolvedValueOnce({
          ...mockRefreshToken,
          revokedAt: new Date(Date.now() - 5_000),
          revokedReason: 'ROTATED',
          replacedByHash: 'hash-nastepcy',
        })
        // Ten sam wiersz czytany drugi raz, pod zamkiem sesji (`lockUserSessions`).
        .mockResolvedValueOnce({
          ...mockRefreshToken,
          revokedAt: new Date(Date.now() - 5_000),
          revokedReason: 'ROTATED',
          replacedByHash: 'hash-nastepcy',
        })
        // Następca unieważniony = klient parę dostał i poszedł dalej.
        .mockResolvedValueOnce({ revokedAt: new Date(Date.now() - 1_000) });
      prisma.refreshToken.updateMany.mockResolvedValueOnce({ count: 3 });

      await expect(service.refreshAccessToken('stary-token')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: mockRefreshToken.userId },
        data: { tokenVersion: { increment: 1 } },
      });
    });

    // ─── PROD 18.09.2026: telefon w szufladzie przez kilka dni ───────────
    //
    // Przyczyna wylogowań „odpaliłem apkę po kilku dniach i znowu mnie
    // wyrzuciło". Cichy push budzi aplikację w tle, ta woła `/auth/refresh`,
    // serwer rotuje token — i iOS zawiesza proces, zanim odpowiedź trafi do
    // Keychaina. Telefon leży kilka dni, po czym pokazuje token zrotowany
    // dawno temu. Do 18.09 decydował o tym ZEGAR i taki telefon dostawał
    // `replay`: skasowanie rodziny, `tokenVersion++` i wylogowanie ze
    // WSZYSTKICH urządzeń. Teraz decyduje NASTĘPCA.

    /**
     * Ustawia `REFRESH_STRICT_REUSE` na czas `run` i ZAWSZE przywraca stan
     * sprzed testu — wynik nie może zależeć od środowiska, w którym biegnie
     * suita. `undefined` = zmienna nieustawiona.
     */
    const withStrictReuse = async (
      value: string | undefined,
      run: () => Promise<void>,
    ) => {
      const before = process.env.REFRESH_STRICT_REUSE;
      if (value === undefined) delete process.env.REFRESH_STRICT_REUSE;
      else process.env.REFRESH_STRICT_REUSE = value;
      try {
        await run();
      } finally {
        if (before === undefined) delete process.env.REFRESH_STRICT_REUSE;
        else process.env.REFRESH_STRICT_REUSE = before;
      }
    };

    const lostRotationDaysAgo = () => {
      prisma.refreshToken.findUnique
        .mockResolvedValueOnce({
          ...mockRefreshToken,
          revokedAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
          revokedReason: 'ROTATED',
          replacedByHash: 'hash-nastepcy',
        })
        // Ten sam wiersz czytany drugi raz, pod zamkiem sesji (`lockUserSessions`).
        .mockResolvedValueOnce({
          ...mockRefreshToken,
          revokedAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
          revokedReason: 'ROTATED',
          replacedByHash: 'hash-nastepcy',
        })
        // Nikt nigdy nie użył następcy.
        .mockResolvedValueOnce({ revokedAt: null });
      prisma.refreshToken.updateMany.mockResolvedValueOnce({ count: 1 });
    };

    it.each([' false ', 'FALSE', 'false'])(
      'tryb łagodny (REFRESH_STRICT_REUSE=%j): zgubiona rotacja sprzed DNI, następca nietknięty → świeża para, rodzina żyje',
      async (value) => {
        await withStrictReuse(value, async () => {
          lostRotationDaysAgo();

          const result = await service.refreshAccessToken('stary-token');

          expect(result).toHaveProperty('refreshToken');
          // Rodzina NIE pada, więc pozostałe urządzenia zostają zalogowane.
          expect(prisma.user.updateMany).not.toHaveBeenCalled();
        });
      },
    );

    it('rozwidlony łańcuch kasuje rodzinę także wtedy, gdy rotacja była przed chwilą', async () => {
      prisma.refreshToken.findUnique
        .mockResolvedValueOnce({
          ...mockRefreshToken,
          revokedAt: new Date(Date.now() - 5_000),
          revokedReason: 'ROTATED',
          replacedByHash: 'hash-nastepcy',
        })
        // Ten sam wiersz czytany drugi raz, pod zamkiem sesji (`lockUserSessions`).
        .mockResolvedValueOnce({
          ...mockRefreshToken,
          revokedAt: new Date(Date.now() - 5_000),
          revokedReason: 'ROTATED',
          replacedByHash: 'hash-nastepcy',
        })
        // Następca UŻYTY = para dotarła i żyje własnym życiem, a mimo to wraca
        // stary token. To jedyny przypadek z dowodem na dwie kopie.
        .mockResolvedValueOnce({ revokedAt: new Date() });

      await expect(service.refreshAccessToken('stary-token')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.user.updateMany).toHaveBeenCalled();
      expect(jwt.signAsync).not.toHaveBeenCalled();
    });

    // DOMYŚLNIE STRICT (od 21.09.2026). Łagodny tryb włącza wyłącznie jawne
    // `false`; brak zmiennej, pusta wartość i literówka mają kończyć się
    // BEZPIECZNIEJSZYM zachowaniem, nie luźniejszym.
    it.each([undefined, '', 'true', 'TRUE', 'tak', 'flase'])(
      'strict (REFRESH_STRICT_REUSE=%j): ta sama rotacja sprzed DNI kasuje rodzinę i nie wydaje pary',
      async (value) => {
        await withStrictReuse(value, async () => {
          lostRotationDaysAgo();

          await expect(
            service.refreshAccessToken('stary-token'),
          ).rejects.toThrow(UnauthorizedException);
          expect(prisma.user.updateMany).toHaveBeenCalled();
          expect(jwt.signAsync).not.toHaveBeenCalled();
        });
      },
    );

    it('strict NIE zabiera ratunku W oknie łaski — zgubiona odpowiedź dalej dostaje parę', async () => {
      await withStrictReuse('true', async () => {
        prisma.refreshToken.findUnique
          .mockResolvedValueOnce({
            ...mockRefreshToken,
            revokedAt: new Date(Date.now() - 5_000),
            revokedReason: 'ROTATED',
            replacedByHash: 'hash-nastepcy',
          })
          // Ten sam wiersz czytany drugi raz, pod zamkiem sesji (`lockUserSessions`).
          .mockResolvedValueOnce({
            ...mockRefreshToken,
            revokedAt: new Date(Date.now() - 5_000),
            revokedReason: 'ROTATED',
            replacedByHash: 'hash-nastepcy',
          })
          .mockResolvedValueOnce({ revokedAt: null });
        prisma.refreshToken.updateMany.mockResolvedValueOnce({ count: 1 });

        const result = await service.refreshAccessToken('stary-token');

        expect(result).toHaveProperty('refreshToken');
        expect(prisma.user.updateMany).not.toHaveBeenCalled();
      });
    });

    it('wygasły token nie jest ratowany, ale też nie kasuje rodziny', async () => {
      prisma.refreshToken.findUnique.mockResolvedValueOnce({
        ...mockRefreshToken,
        expiresAt: new Date(Date.now() - 1_000),
        revokedAt: new Date(Date.now() - 10 * 60 * 1000),
        revokedReason: 'ROTATED',
        replacedByHash: 'hash-nastepcy',
      });

      await expect(service.refreshAccessToken('stary-token')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('token unieważniony przez LOGOUT nigdy nie jest ratowany', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        ...mockRefreshToken,
        revokedAt: new Date(Date.now() - 1_000),
        revokedReason: 'LOGOUT',
        replacedByHash: null,
      });

      await expect(service.refreshAccessToken('wylogowany')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(jwt.signAsync).not.toHaveBeenCalled();
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

  // ─── audyt cyklu życia sesji 21.09.2026 ───────────────────────────────────

  describe('audyt sesji 21.09.2026', () => {
    const rotatedWithSuccessor = (reason: 'ROTATED' | 'RECOVERED') => ({
      ...mockRefreshToken,
      revokedAt: new Date(Date.now() - 5_000),
      revokedReason: reason,
      replacedByHash: 'hash-nastepcy',
    });

    it('wykrycie replayu przepisuje powód na WSZYSTKICH starych tokenach — kolejne echo nie ma czego kasować', async () => {
      const presented = rotatedWithSuccessor('ROTATED');
      prisma.refreshToken.findUnique
        .mockResolvedValueOnce(presented)
        .mockResolvedValueOnce(presented)
        // Następca UŻYTY — łańcuch rozwidlony.
        .mockResolvedValueOnce({
          revokedAt: new Date(),
          revokedReason: 'ROTATED',
        });

      await expect(service.refreshAccessToken('kopia')).rejects.toThrow(
        UnauthorizedException,
      );

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: mockRefreshToken.userId, revokedAt: null },
        data: { revokedAt: expect.any(Date), revokedReason: 'REUSE' },
      });
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: {
          userId: mockRefreshToken.userId,
          revokedReason: { in: ['ROTATED', 'RECOVERED'] },
        },
        data: { revokedReason: 'REUSE' },
      });
      expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    });

    it('echo: ten sam token po wykryciu (już REUSE) = 401 bez kasowania i bez podbicia tokenVersion', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        ...rotatedWithSuccessor('ROTATED'),
        revokedReason: 'REUSE',
      });
      await expect(service.refreshAccessToken('echo')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it('następca zgaszony WYLOGOWANIEM, poprzednik ROTATED: 401 bez kasowania rodziny i bez nowej pary', async () => {
      const presented = rotatedWithSuccessor('ROTATED');
      prisma.refreshToken.findUnique
        .mockResolvedValueOnce(presented)
        .mockResolvedValueOnce(presented)
        .mockResolvedValueOnce({
          revokedAt: new Date(),
          revokedReason: 'LOGOUT',
        });

      await expect(service.refreshAccessToken('ponowienie')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      expect(jwt.signAsync).not.toHaveBeenCalled();
    });

    it('następca zgaszony wylogowaniem, ale poprzednik RECOVERED (istnieje para spoza łańcucha): rodzina pada', async () => {
      const presented = rotatedWithSuccessor('RECOVERED');
      prisma.refreshToken.findUnique
        .mockResolvedValueOnce(presented)
        .mockResolvedValueOnce(presented)
        .mockResolvedValueOnce({
          revokedAt: new Date(),
          revokedReason: 'LOGOUT',
        });

      await expect(service.refreshAccessToken('kopia')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: mockRefreshToken.userId },
        data: { tokenVersion: { increment: 1 } },
      });
    });

    it('decyzja o ratunku zapada na świeżym odczycie pod zamkiem: token unieważniony w międzyczasie nie dostaje pary', async () => {
      prisma.refreshToken.findUnique
        // Odczyt przed transakcją: wygląda na zgubioną odpowiedź…
        .mockResolvedValueOnce(rotatedWithSuccessor('ROTATED'))
        // …ale pod zamkiem widać, że w międzyczasie przyszło wylogowanie zewsząd.
        .mockResolvedValueOnce({
          ...rotatedWithSuccessor('ROTATED'),
          revokedReason: 'LOGOUT',
        });

      await expect(service.refreshAccessToken('spozniony')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      expect(jwt.signAsync).not.toHaveBeenCalled();
    });

    it('rotacja i ratunek biorą zamek sesji jako PIERWSZĄ operację transakcji', async () => {
      const calls: string[] = [];
      prisma.$queryRaw.mockImplementation(() => {
        calls.push('lock');
        return Promise.resolve([]);
      });
      prisma.refreshToken.updateMany.mockImplementation(() => {
        calls.push('updateMany');
        return Promise.resolve({ count: 1 });
      });

      await service.refreshAccessToken('zwykly');

      expect(calls[0]).toBe('lock');
      const sql = (prisma.$queryRaw.mock.calls[0][0] as string[]).join('?');
      expect(sql).toContain('FOR NO KEY UPDATE');
      expect(sql).toContain('"User"');
    });

    it('token dostępu z rotacji niesie wersję odczytaną W transakcji, nie po niej', async () => {
      prisma.user.findUnique.mockResolvedValue({ tokenVersion: 7 });
      await service.refreshAccessToken('zwykly');
      expect(jwt.signAsync).toHaveBeenCalledWith(
        { sub: mockRefreshToken.userId, tv: 7 },
        expect.anything(),
      );
      // Jeden odczyt wersji — ten w transakcji.
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    });
  });

  describe('logoutEverywhere', () => {
    it('pod zamkiem: żywe → LOGOUT, stare zrotowane/ratowane → LOGOUT, tokenVersion +1, zwraca liczbę sesji', async () => {
      prisma.refreshToken.updateMany
        .mockResolvedValueOnce({ count: 3 })
        .mockResolvedValueOnce({ count: 5 });

      await expect(service.logoutEverywhere('user-123')).resolves.toEqual({
        revokedSessions: 3,
      });

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(prisma.refreshToken.updateMany).toHaveBeenNthCalledWith(1, {
        where: { userId: 'user-123', revokedAt: null },
        data: { revokedAt: expect.any(Date), revokedReason: 'LOGOUT' },
      });
      expect(prisma.refreshToken.updateMany).toHaveBeenNthCalledWith(2, {
        where: {
          userId: 'user-123',
          revokedReason: { in: ['ROTATED', 'RECOVERED'] },
        },
        data: { revokedReason: 'LOGOUT' },
      });
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: 'user-123' },
        data: { tokenVersion: { increment: 1 } },
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
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
        data: { revokedAt: expect.any(Date), revokedReason: 'LOGOUT' },
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
