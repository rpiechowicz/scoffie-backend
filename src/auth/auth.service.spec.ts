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

const makePrismaMock = () => {
  const prisma = {
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
    // Transakcja interaktywna: bez bazy nie ma czego izolować, więc callback
    // dostaje ten sam mock. Testy patrzą na to, CO poszło w jednym zapytaniu.
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(
    (run: (tx: typeof prisma) => unknown) => run(prisma),
  );
  return prisma;
};

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
        // Odczyt następcy: żyje, więc para mogła nie dojechać.
        .mockResolvedValueOnce({ revokedAt: null });

      const result = await service.refreshAccessToken('ponowiony-token');

      expect(result).toHaveProperty('accessToken', 'mock-access-token');
      expect(result).toHaveProperty('refreshToken');
      // Rodzina żyje, tokeny dostępu zostają ważne.
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
      // Ślad idzie na PRZEDSTAWIONYM tokenie, nie na następcy.
      expect(prisma.refreshToken.updateMany).toHaveBeenNthCalledWith(2, {
        where: { tokenHash: mockRefreshToken.tokenHash },
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
        where: { tokenHash: mockRefreshToken.tokenHash },
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
        .mockResolvedValueOnce({ revokedAt: null });
      prisma.refreshToken.updateMany.mockResolvedValueOnce({ count: 1 });

      await service.refreshAccessToken('stary-token');

      // Następca jest tylko CZYTANY.
      expect(prisma.refreshToken.findUnique).toHaveBeenNthCalledWith(2, {
        where: { tokenHash: 'hash-nastepcy' },
        select: { revokedAt: true },
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

    it('drugie powtórzenie tego samego tokenu już nie ratuje — rodzina pada', async () => {
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

    it('poza oknem łaski nie ratujemy — stara kopia tokenu kasuje rodzinę', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        ...mockRefreshToken,
        revokedAt: new Date(Date.now() - 10 * 60 * 1000),
        revokedReason: 'ROTATED',
        replacedByHash: 'hash-nastepcy',
      });

      await expect(service.refreshAccessToken('stary-token')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.user.updateMany).toHaveBeenCalled();
      expect(jwt.signAsync).not.toHaveBeenCalled();
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
