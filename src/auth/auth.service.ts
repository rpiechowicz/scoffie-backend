import {
  BadRequestException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthProvider, Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { AppException } from '../common/app-exception';
import { purchaseIdentityHashForUser } from '../config/purchase-identity';
import { PrismaService } from '../prisma/prisma.service';
import { AppleIdentityService } from './apple-identity.service';
import { AppleSignInDto } from './dto/apple-sign-in.dto';
import { DevLoginDto } from './dto/dev-login.dto';
import { resolveJwtExpiresIn } from './jwt-expiration.util';

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    displayName: string;
    email: string | null;
    avatarUrl: string | null;
    /**
     * Indeks gradientu awatara przydzielony przy kończeniu onboardingu.
     * Jedzie już w odpowiedzi logowania, bo bez niego klient do czasu
     * pierwszego `users:me` kolorował własny awatar fallbackiem z hasza —
     * innym odcieniem niż ten, którym ta sama osoba świeci na listach
     * domowników.
     */
    avatarColor: number | null;
    provider: AuthProvider;
    onboardingCompletedAt: string | null;
  };
  household: { id: string; name: string } | null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  // Refresh dłuższy niż access (domyślnie 30 d): równe TTL oznaczały, że
  // odświeżenie po wygaśnięciu access tokenu trafiało w równie martwy
  // refresh token.
  private readonly refreshTokenDays =
    Number(process.env.REFRESH_TOKEN_DAYS ?? '60') || 60;
  private readonly refreshTokenPepper =
    process.env.REFRESH_TOKEN_PEPPER ?? process.env.JWT_SECRET ?? 'dev-pepper';
  /**
   * Okno laski na ZGUBIONA ODPOWIEDZ z rotacji (`REFRESH_REUSE_GRACE_SECONDS`).
   *
   * Telefon wysyla refresh, serwer rotuje token, iOS uspia proces i odpowiedz
   * nigdy nie dojezdza. W Keychain zostaje stary token, a nastepne
   * uruchomienie wyglada jak replay. Minuta wystarcza z zapasem (zadanie ma
   * 15 s timeoutu na telefonie), a jest za krotka, zeby dac cokolwiek komus,
   * kto wszedl w posiadanie kopii sprzed godzin.
   */
  private readonly refreshReuseGraceMs =
    (Number(process.env.REFRESH_REUSE_GRACE_SECONDS ?? '60') || 60) * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly appleIdentity: AppleIdentityService,
  ) {}

  /**
   * Sign in with Apple.
   *
   * Steps:
   *  1. Verify the identity token against Apple's JWKS (signature, iss, aud, exp, nonce).
   *  2. Upsert a User keyed by the Apple `sub` claim.
   *  3. On first sign-in, Apple returns an email + optional fullName. Persist them once;
   *     subsequent sign-ins will NOT contain the name, so we never overwrite a good
   *     displayName with the fallback.
   *  4. Issue our own JWT + refresh token.
   */
  async loginWithApple(dto: AppleSignInDto): Promise<AuthResult> {
    if (!dto.identityToken?.trim()) {
      throw new BadRequestException('Missing identityToken.');
    }
    if (!dto.rawNonce?.trim()) {
      throw new BadRequestException('Missing rawNonce.');
    }

    const verified = await this.appleIdentity.verify(
      dto.identityToken.trim(),
      dto.rawNonce.trim(),
    );

    const displayNameFromApple = this.composeAppleDisplayName(
      dto.givenName,
      dto.familyName,
    );

    // Email: prefer the one from the verified JWT (signed by Apple);
    // fall back to DTO only if JWT didn't carry it for some reason.
    const email =
      verified.email ?? (dto.email?.trim().toLowerCase() || null) ?? null;

    // Look up existing user first so we can decide what to update.
    const existing = await this.prisma.user.findUnique({
      where: { appleSub: verified.appleSub },
    });

    let user;
    if (existing) {
      const updateData: Prisma.UserUpdateInput = {
        authProvider: AuthProvider.APPLE,
        lastLoginAt: new Date(),
      };

      // Only overwrite displayName if we got a real one from Apple AND
      // the user currently has the Apple-sub placeholder we assigned on first login.
      if (
        displayNameFromApple &&
        this.isPlaceholderDisplayName(existing.displayName)
      ) {
        updateData.displayName = displayNameFromApple;
      }

      // Only update email if we learn a new one; do not clear it.
      if (email && existing.email !== email) {
        updateData.email = email;
        updateData.emailVerified = verified.emailVerified;
      } else if (existing.email === email) {
        updateData.emailVerified = verified.emailVerified;
      }

      user = await this.prisma.user.update({
        where: { appleSub: verified.appleSub },
        data: updateData,
      });
    } else {
      const fallbackName =
        displayNameFromApple ||
        (email ? email.split('@')[0] : null) ||
        `Apple-${verified.appleSub.slice(0, 8)}`;

      user = await this.prisma.user.create({
        data: {
          appleSub: verified.appleSub,
          authProvider: AuthProvider.APPLE,
          email,
          emailVerified: email ? verified.emailVerified : false,
          displayName: fallbackName,
          lastLoginAt: new Date(),
        },
      });
      this.logger.log(
        `New Apple user created: ${user.id} (appleSub=${verified.appleSub.slice(0, 12)}…)`,
      );
    }

    return this.buildAuthResult(user);
  }

  async loginDev(dto: DevLoginDto): Promise<AuthResult> {
    // Opt-in, nie opt-out: brak zmiennej, literówka albo `FALSE` nie mogą
    // zostawić na produkcji otwartej furtki, która wybija tokeny każdemu,
    // kto poda `displayName`. Dev i CI ustawiają `true` jawnie.
    if (process.env.AUTH_DEV_LOGIN_ENABLED !== 'true') {
      throw new AppException(
        'DEV_LOGIN_DISABLED',
        'Dev login is disabled',
        HttpStatus.FORBIDDEN,
      );
    }

    if (!dto.displayName?.trim()) {
      throw new BadRequestException('Missing displayName');
    }

    const displayName = dto.displayName.trim();
    const normalizedEmail = dto.email?.trim().toLowerCase() || null;
    const googleIdSeed = normalizedEmail || displayName.toLowerCase();
    const googleId = `dev:${googleIdSeed.replace(/\s+/g, '-')}`;

    const user = await this.prisma.user.upsert({
      where: { googleId },
      update: {
        displayName,
        email: normalizedEmail,
        authProvider: AuthProvider.DEV,
        lastLoginAt: new Date(),
      },
      create: {
        googleId,
        displayName,
        email: normalizedEmail,
        authProvider: AuthProvider.DEV,
        lastLoginAt: new Date(),
      },
    });

    return this.buildAuthResult(user);
  }

  /**
   * Rotacja refresh tokenu z wykrywaniem ponownego użycia.
   *
   * Refresh token jest jednorazowy. Jeśli przychodzi token JUŻ unieważniony
   * (przez wcześniejszą rotację albo logout), to albo klient zgubił nową parę,
   * albo ktoś ma kopię starej. Pierwszy przypadek ratuje `recoverLostRotation`
   * (okno łaski), drugi kasuje CAŁĄ rodzinę tokenów usera i klient loguje się
   * od nowa. Dawniej replay dostawał zwykłe 401, a reszta rodziny żyła dalej.
   * Wygasłe wiersze usera sprzątamy przy okazji (każdy login/refresh dokładał
   * wiersz, nic nie usuwało).
   */
  async refreshAccessToken(refreshToken: string) {
    const tokenHash = this.hashRefreshToken(refreshToken);
    const storedToken = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });
    const now = new Date();

    if (storedToken?.revokedAt) {
      // Zanim skasujemy rodzine: czy to nie jest po prostu telefon, do
      // ktorego nowa para nie dojechala? Jesli tak, dostaje swieza i zyje
      // dalej - patrz `recoverLostRotation`.
      const recovered = await this.recoverLostRotation(storedToken, now);
      if (recovered) return recovered;

      await this.revokeTokenFamily(storedToken.userId, now, 'reuse detected');
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    if (!storedToken || storedToken.expiresAt <= now) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const successor = await this.rotateRefreshToken(
      storedToken.userId,
      tokenHash,
      now,
    );
    if (!successor) {
      // Przegrany wyscig: oba zadania widzialy `revokedAt: null` w
      // `findUnique`, ale rotacje wygralo jedno. Warunkowy UPDATE przegranego
      // czekal na zatwierdzenie zwyciezcy, wiec TERAZ wiersz ma juz komplet:
      // ROTATED i wskaznik na nastepce. To ta sama sytuacja co zgubiona
      // odpowiedz — telefon ponawia POST, bo polaczenie padlo, zanim
      // odpowiedz dojechala — wiec ratujemy tak samo, zamiast kasowac rodzine.
      const afterRace = await this.prisma.refreshToken.findUnique({
        where: { tokenHash },
      });
      const recovered = afterRace
        ? await this.recoverLostRotation(afterRace, new Date())
        : null;
      if (recovered) return recovered;

      await this.revokeTokenFamily(storedToken.userId, now, 'concurrent reuse');
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    await this.prisma.refreshToken.deleteMany({
      where: { userId: storedToken.userId, expiresAt: { lt: now } },
    });

    const accessToken = await this.issueAccessToken(storedToken.userId);
    return { accessToken, refreshToken: successor.rawToken };
  }

  /**
   * Rotacja w JEDNEJ transakcji: uniewaznienie poprzednika, wskaznik na
   * nastepce i sam nastepca staja sie widoczne RAZEM.
   *
   * Przedtem szly trzema krokami — najpierw `revokedAt`, potem wydanie nowej
   * pary, a `replacedByHash` dopiero na koncu. Miedzy pierwszym a ostatnim
   * mijalo kilkanascie milisekund, w ktorych wiersz mial ROTATED BEZ nastepcy
   * — a `recoverLostRotation` wlasnie po nastepcy poznaje zgubiona odpowiedz.
   * Ponowiony POST trafial w to okno i zamiast ratunku dostawal kasowanie
   * calej rodziny. Widac to w logach prod z 11.09.2026: `201` i
   * `reuse detected` w tej samej sekundzie, po nich wylogowanie.
   *
   * `null` = rotacje wygral ktos inny; wywolujacy sprawdza, czy da sie
   * uratowac.
   */
  private async rotateRefreshToken(
    userId: string,
    tokenHash: string,
    now: Date,
  ): Promise<{ rawToken: string; tokenHash: string } | null> {
    const rawToken = randomBytes(64).toString('hex');
    const successorHash = this.hashRefreshToken(rawToken);
    const expiresAt = new Date(now);
    expiresAt.setDate(expiresAt.getDate() + this.refreshTokenDays);

    return this.prisma.$transaction(async (tx) => {
      // Uniewaznienie warunkowe (`revokedAt: null`): to samo zapytanie
      // sprawdza i zajmuje, wiec z dwoch rownoleglych zadan tym samym tokenem
      // pare wyda tylko jedno. Drugie czeka tutaj na blokadzie wiersza.
      const rotated = await tx.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: {
          revokedAt: now,
          revokedReason: 'ROTATED',
          replacedByHash: successorHash,
        },
      });
      if (rotated.count === 0) return null;

      await tx.refreshToken.create({
        data: { tokenHash: successorHash, userId, expiresAt },
      });
      return { rawToken, tokenHash: successorHash };
    });
  }

  /**
   * Replay, ktorego nie tlumaczy zgubiona odpowiedz: cala rodzina refresh
   * tokenow pada. Tokeny DOSTEPU zylyby dalej do konca swojego TTL, wiec
   * `tokenVersion` uniewaznia je natychmiast.
   */
  private async revokeTokenFamily(userId: string, now: Date, reason: string) {
    const revoked = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now, revokedReason: 'REUSE' },
    });
    await this.prisma.user.updateMany({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    });
    this.logger.warn(
      `refresh token ${reason} for user ${userId} — revoked ${revoked.count} active token(s)`,
    );
  }

  /**
   * Ratunek dla telefonu, ktory zgubil odpowiedz z rotacji.
   *
   * Warunki sa celowo waskie i musza zajsc WSZYSTKIE naraz:
   *  - token uniewaznila ROTACJA (nie logout i nie wykryty wczesniej replay),
   *  - miescimy sie w oknie laski (`REFRESH_REUSE_GRACE_SECONDS`),
   *  - sam token nie zdazyl wygasnac,
   *  - a nastepca jest NIETKNIETY.
   *
   * Ostatni warunek jest najwazniejszy: jesli nastepca zostal juz uzyty, to
   * znaczy, ze para DOTARLA do klienta - a skoro stary token wraca mimo to,
   * mamy kopie i rodzina musi pasc. Dlatego uniewaznienie nastepcy idzie
   * warunkowym `updateMany` (`revokedAt: null`): to samo zapytanie sprawdza
   * i zajmuje, wiec dwa rownolegle ratunki nie wydadza dwoch waznych par.
   *
   * `null` = nie ratujemy, wywolujacy idzie sciezka kasowania rodziny.
   */
  private async recoverLostRotation(
    storedToken: {
      tokenHash: string;
      userId: string;
      revokedAt: Date | null;
      revokedReason: string | null;
      replacedByHash: string | null;
      expiresAt: Date;
    },
    now: Date,
  ): Promise<{ accessToken: string; refreshToken: string } | null> {
    const { revokedAt, revokedReason, replacedByHash } = storedToken;
    // Kazda odmowa konczy sie kasowaniem rodziny, czyli wylogowaniem — wiec
    // kazda mowi, CO ja wywolalo. Bez tego jedyny slad po wylogowaniu to
    // `reuse detected`, z ktorego nie wynika, ktory warunek nie wyszedl.
    if (revokedReason !== 'ROTATED' || !revokedAt || !replacedByHash) {
      this.logger.warn(
        `rotation recovery refused for user ${storedToken.userId}: reason=${revokedReason ?? 'NULL'} successor=${replacedByHash ? 'set' : 'missing'}`,
      );
      return null;
    }
    const ageMs = now.getTime() - revokedAt.getTime();
    if (ageMs > this.refreshReuseGraceMs) {
      this.logger.warn(
        `rotation recovery refused for user ${storedToken.userId}: rotated ${Math.round(ageMs / 1000)}s ago, grace ${this.refreshReuseGraceMs / 1000}s`,
      );
      return null;
    }
    if (storedToken.expiresAt <= now) {
      this.logger.warn(
        `rotation recovery refused for user ${storedToken.userId}: token expired`,
      );
      return null;
    }

    // Porzucony nastepca ginie jako REUSE, nie ROTATED, i nie dostaje
    // wskaznika na nikogo. Gdyby ginal jako ROTATED z lancuchem, jego wlasne
    // powtorzenie tez by sie ratowalo — i okno laski dawaloby sie przedluzac
    // w nieskonczonosc, przesuwajac je co ratunek o kolejna minute.
    const claimed = await this.prisma.refreshToken.updateMany({
      where: { tokenHash: replacedByHash, revokedAt: null },
      data: { revokedAt: now, revokedReason: 'REUSE' },
    });
    if (claimed.count === 0) {
      this.logger.warn(
        `rotation recovery refused for user ${storedToken.userId}: successor already used or revoked`,
      );
      return null;
    }

    // Ratunek jest JEDNORAZOWY na rotacje: to samo powtorzenie drugi raz nie
    // jest juz zgubiona odpowiedzia, tylko kopia, i idzie kasowaniem rodziny.
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: storedToken.tokenHash },
      data: { revokedReason: 'RECOVERED' },
    });

    const accessToken = await this.issueAccessToken(storedToken.userId);
    const successor = await this.issueRefreshToken(storedToken.userId);
    this.logger.log(
      `refresh token rotation recovered for user ${storedToken.userId} - client never received the rotated pair`,
    );
    return { accessToken, refreshToken: successor.rawToken };
  }

  /**
   * Wylogowanie: unieważnia podany refresh token. Idempotentne i bez
   * zdradzania, czy token istniał — klient woła to best-effort przy logout
   * (dotąd logout był tylko lokalny, a refresh token żył jeszcze 30 dni).
   */
  async logout(refreshToken: string): Promise<{ revoked: boolean }> {
    const tokenHash = this.hashRefreshToken(refreshToken);
    const result = await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'LOGOUT' },
    });
    return { revoked: result.count > 0 };
  }

  async issueAccessToken(userId: string) {
    const expiresIn = resolveJwtExpiresIn(process.env.JWT_EXPIRES_IN);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { tokenVersion: true },
    });
    return this.jwtService.signAsync(
      { sub: userId, tv: user?.tokenVersion ?? 0 },
      { expiresIn },
    );
  }

  /**
   * Wylogowanie ZEWSZĄD: wszystkie refresh tokeny i wszystkie tokeny dostępu
   * tej osoby przestają działać. Zwykłe `logout` gasi jedno urządzenie.
   */
  async logoutEverywhere(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'LOGOUT' },
    });
    await this.prisma.user.updateMany({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    });
  }

  /**
   * Dopisuje hasz tożsamości zakupowej, jeśli konto go jeszcze nie ma.
   *
   * Robione przy KAŻDYM wejściu (logowanie i odświeżenie tokenu), nie tylko
   * przy zakładaniu konta, bo hasz ma dwa zadania wstecz: przypiąć z powrotem
   * subskrypcję osobie, która skasowała konto i wróciła, oraz odnaleźć jej
   * wypaloną pulę próbną. Konta założone przed tą zmianą dostają hasz przy
   * najbliższym logowaniu.
   *
   * Zapis warunkowy (`updateMany` z `identityHash: null`), bo hasz raz nadany
   * nigdy się nie zmienia — a dwa równoległe logowania nie mają prawa go
   * przestawić.
   */
  private async ensurePurchaseIdentity(user: {
    id: string;
    identityHash?: string | null;
    appleSub?: string | null;
    googleId?: string | null;
    authProvider?: AuthProvider;
  }): Promise<void> {
    if (user.identityHash) return;
    const hash = purchaseIdentityHashForUser(user);
    if (!hash) return;
    try {
      await this.prisma.user.updateMany({
        where: { id: user.id, identityHash: null },
        data: { identityHash: hash },
      });
    } catch (error) {
      // Logowanie nie ma prawa się wywalić przez ślad zakupowy — bez hasza
      // pula próbna po prostu siada na `User.id` do następnego razu.
      this.logger.warn(
        `Nie udało się zapisać identityHash dla ${user.id}: ${String(error)}`,
      );
    }
  }

  private async buildAuthResult(user: {
    id: string;
    displayName: string;
    email: string | null;
    avatarUrl: string | null;
    avatarColor: number | null;
    authProvider: AuthProvider;
    onboardingCompletedAt: Date | null;
    identityHash?: string | null;
    appleSub?: string | null;
    googleId?: string | null;
  }): Promise<AuthResult> {
    await this.ensurePurchaseIdentity(user);
    // „Które gospodarstwo": NAJSTARSZE członkostwo. To jest jedyne miejsce,
    // które to rozstrzyga dla klienta (`currentHouseholdId`); to samo robi
    // `cookidoo-integration.service.ts` po JWT. Gatewaye WS biorą
    // `householdId` z payloadu i sprawdzają tylko członkostwo — dopóki socket
    // nie ma auth (Faza 0), nie da się tego ujednolicić po stronie serwera.
    // `households.create` i `acceptInvitation` pilnują, żeby członkostwo było
    // jedno, więc „najstarsze" znaczy w praktyce „jedyne".
    const [accessToken, issuedRefresh, membership] = await Promise.all([
      this.issueAccessToken(user.id),
      this.issueRefreshToken(user.id),
      this.prisma.membership.findFirst({
        where: { userId: user.id },
        include: { household: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    return {
      accessToken,
      refreshToken: issuedRefresh.rawToken,
      user: {
        id: user.id,
        displayName: user.displayName,
        email: user.email,
        avatarUrl: user.avatarUrl ?? null,
        avatarColor: user.avatarColor ?? null,
        provider: user.authProvider,
        onboardingCompletedAt:
          user.onboardingCompletedAt?.toISOString() ?? null,
      },
      household: membership?.household
        ? { id: membership.household.id, name: membership.household.name }
        : null,
    };
  }

  /**
   * Pierwszy refresh token sesji (logowanie). Rotacja idzie osobna droga —
   * `rotateRefreshToken` — bo musi wydac nastepce w tej samej transakcji, co
   * uniewaznienie poprzednika.
   */
  private async issueRefreshToken(userId: string) {
    const rawToken = randomBytes(64).toString('hex');
    const tokenHash = this.hashRefreshToken(rawToken);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + this.refreshTokenDays);

    await this.prisma.refreshToken.create({
      data: {
        tokenHash,
        userId,
        expiresAt,
      },
    });

    return { rawToken, tokenHash };
  }

  private hashRefreshToken(token: string) {
    return createHash('sha256')
      .update(token)
      .update(this.refreshTokenPepper)
      .digest('hex');
  }

  private composeAppleDisplayName(
    givenName?: string,
    familyName?: string,
  ): string | null {
    const parts = [givenName, familyName]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value && value.length));
    return parts.length > 0 ? parts.join(' ') : null;
  }

  /**
   * `displayName` placeholders we auto-generated on first login
   * (e.g. "Apple-abcd1234" or email-local-part). If the user hasn't changed
   * them, overwrite them when Apple finally gives us a real name.
   */
  private isPlaceholderDisplayName(displayName: string): boolean {
    if (!displayName) return true;
    if (displayName.startsWith('Apple-')) return true;
    // Email-local-part heuristic — a single lowercase token without spaces.
    return /^[a-z0-9._-]+$/.test(displayName);
  }
}
