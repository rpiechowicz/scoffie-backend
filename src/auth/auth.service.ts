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
import { disconnectRevokedUser } from '../common/ws-rooms';
import { AppleIdentityService } from './apple-identity.service';
import { AppleSignInDto } from './dto/apple-sign-in.dto';
import { DevLoginDto } from './dto/dev-login.dto';
import { GoogleSignInDto } from './dto/google-sign-in.dto';
import {
  GoogleIdentityService,
  type VerifiedGoogleIdentity,
} from './google-identity.service';
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
  /**
   * Polityka dla starego tokenu, ktory wraca PO oknie laski, choc jego
   * nastepcy nikt nie uzyl (`REFRESH_STRICT_REUSE`).
   *
   * DOMYSLNIE STRICT (od 21.09.2026): taka proba kasuje CALA rodzine tokenow.
   * Lagodny tryb byl domyslny przez trzy dni (18–21.09.2026) i mial koszt,
   * ktory e2e przypina wprost: para wydana „ratunkiem na zimno" nie jest
   * spieta z lancuchem, wiec gdy wlasciciel uzyje potem swojego nastepcy,
   * rozwidlenia NIC juz nie wykrywa — kopia starego tokenu i wlasciciel
   * pracuja rownolegle, bez sladu. Swiezy refresh token lezy u klienta
   * nieuzywany nawet godzine (do konca access tokenu), wiec to nie jest
   * przypadek brzegowy.
   *
   * Lagodny tryb wlacza WYLACZNIE jawne `REFRESH_STRICT_REUSE=false`. Brak
   * zmiennej, pusta wartosc i literowka daja strict: pomylka w konfiguracji
   * ma konczyc sie bezpieczniejszym zachowaniem, nie luzniejszym. Cena strict
   * tez jest realna — telefon, ktory zgubil odpowiedz z rotacji i wrocil po
   * oknie, wylogowuje wlasciciela ze wszystkich urzadzen — dlatego to zostaje
   * przelacznikiem wlasciciela instalacji. Czytane per zadanie.
   */
  private get strictReuse(): boolean {
    return (
      (process.env.REFRESH_STRICT_REUSE ?? '').trim().toLowerCase() !== 'false'
    );
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly appleIdentity: AppleIdentityService,
    private readonly googleIdentity: GoogleIdentityService,
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

    // Adres WYŁĄCZNIE z identity tokenu — to jedyna wartość podpisana przez
    // Apple. `dto.email` jest tekstem wpisanym przez klienta.
    //
    // AUDYT 21.09.2026. Dawniej token bez claimu `email` oznaczał „weź adres
    // z DTO": dowolne konto Apple mogło wpisać sobie cudzy adres, a powitanie,
    // pożegnanie i maile o subskrypcji (z nazwą wybraną przez nadawcę) szły
    // do osoby trzeciej. Przy istniejącym koncie ta sama gałąź przepisywała
    // `emailVerified` z tokenu na adres, którego token nie niósł.
    //
    // Pole zostaje w DTO (kontrakt z iOS), ale niczego nie zapisuje. Rozjazd
    // z tokenem tylko odnotowujemy — BEZ adresów w logu.
    const email = verified.email;
    const declaredEmail = dto.email?.trim().toLowerCase() || null;
    if (declaredEmail && declaredEmail !== email) {
      this.logger.warn(
        `Apple sign-in: dto.email ${
          email ? 'differs from' : 'sent without'
        } the identity token email claim — ignored`,
      );
    }

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
      // `emailVerified` opisuje adres Z TOKENU, więc rusza się tylko razem
      // z nim — token bez adresu nie potwierdza niczego, co leży w bazie.
      if (email) {
        if (existing.email !== email) updateData.email = email;
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
      // Sam `user.id`: adres i `sub` Apple to dane osobowe, w logu zbędne.
      this.logger.log(`New Apple user created: ${user.id}`);
    }

    return this.buildAuthResult(user);
  }

  /**
   * Logowanie przez Google (aplikacja Android).
   *
   * Kolejność dopasowania konta:
   *  1. `googleId = sub` — osoba logowała się już przez Google.
   *  2. ŁĄCZENIE PO ADRESIE (decyzja właściciela, 25.09.2026): gdy Google
   *     potwierdza adres (`email_verified === true`) i istnieje DOKŁADNIE jedno
   *     konto z tym samym adresem (bez wielkości liter), POTWIERDZONYM
   *     (`emailVerified`) i bez `googleId` — dopisujemy mu `googleId`. Konto
   *     zostaje sobą: `authProvider`, `appleSub` i `identityHash` bez zmian,
   *     więc pula próbna i subskrypcja zostają przy nim. Adresy przekaźnikowe
   *     Apple (`@privaterelay.appleid.com`) nie trafią na adres Google — to
   *     oczekiwane, taka osoba dostaje nowe konto.
   *  3. Nowe konto `authProvider = GOOGLE`; `identityHash` z `GOOGLE:sub`
   *     liczy `buildAuthResult` tą samą drogą co dla Apple.
   *
   * Profil wyłącznie z podpisanego tokenu. W logach tylko `user.id`.
   * Stanów „usunięte/zablokowane” nie ma: usunięcie konta kasuje wiersz
   * (ponowne logowanie = nowe konto, jak przy Apple), blokady nie ma w modelu.
   *
   * `platform` nie trafia do bazy: `RefreshToken` nie ma kolumny na platformę
   * ani urządzenie.
   */
  async loginWithGoogle(dto: GoogleSignInDto): Promise<AuthResult> {
    // Najpierw „wyłączone”: bez konfiguracji nie ma czego weryfikować, a klient
    // ma dostać 503, nie 400 za puste pole.
    this.googleIdentity.assertEnabled();
    if (!dto.idToken?.trim()) {
      throw new BadRequestException('Missing idToken.');
    }

    const verified = await this.googleIdentity.verify(
      dto.idToken.trim(),
      dto.nonce ?? null,
    );
    const now = new Date();

    const byGoogleId = await this.prisma.user.findUnique({
      where: { googleId: verified.googleSub },
    });
    if (byGoogleId) {
      return this.buildAuthResult(
        await this.touchGoogleUser(byGoogleId, verified, now),
      );
    }

    const linked = await this.linkGoogleByEmail(verified, now);
    if (linked) return this.buildAuthResult(linked);

    const displayName =
      verified.name ||
      [verified.givenName, verified.familyName].filter(Boolean).join(' ') ||
      (verified.email ? verified.email.split('@')[0] : null) ||
      `Google-${verified.googleSub.slice(0, 8)}`;

    try {
      const user = await this.prisma.user.create({
        data: {
          googleId: verified.googleSub,
          authProvider: AuthProvider.GOOGLE,
          email: verified.email,
          emailVerified: verified.emailVerified,
          displayName: displayName.slice(0, 80),
          avatarUrl: verified.picture,
          lastLoginAt: now,
        },
      });
      this.logger.log(`New Google user created: ${user.id}`);
      return this.buildAuthResult(user);
    } catch (error) {
      // Dwa równoległe pierwsze logowania tym samym kontem Google: oba nie
      // znalazły `googleId`, jedno wygrało `create`, drugie wpada na unikat.
      // Przegrany loguje się na konto zwycięzcy zamiast oddawać 500.
      if (!this.isUniqueViolation(error)) throw error;
      const winner = await this.prisma.user.findUnique({
        where: { googleId: verified.googleSub },
      });
      if (!winner) throw error;
      return this.buildAuthResult(
        await this.touchGoogleUser(winner, verified, now),
      );
    }
  }

  /**
   * Łączenie z istniejącym kontem po potwierdzonym adresie. `null` = nie ma
   * z czym łączyć (albo niejednoznacznie) — wołający zakłada nowe konto.
   */
  private async linkGoogleByEmail(verified: VerifiedGoogleIdentity, now: Date) {
    if (!verified.email || !verified.emailVerified) return null;

    const candidates = await this.prisma.user.findMany({
      where: {
        email: { equals: verified.email, mode: 'insensitive' },
        emailVerified: true,
        googleId: null,
      },
      select: { id: true },
      take: 2,
    });
    if (candidates.length !== 1) {
      if (candidates.length > 1) {
        // Dwa potwierdzone konta z jednym adresem (np. dwa Apple ID) — nie
        // zgadujemy, które jest „tym”. Bez adresu w logu.
        this.logger.warn(
          'Google sign-in: ambiguous e-mail match (>1 verified account) — not linking',
        );
      }
      return null;
    }

    const targetId = candidates[0].id;
    try {
      // Warunkowo: `googleId: null` i `emailVerified` jeszcze raz W zapisie —
      // równoległe łączenie innym kontem Google nie nadpisze zwycięzcy.
      const claimed = await this.prisma.user.updateMany({
        where: { id: targetId, googleId: null, emailVerified: true },
        data: { googleId: verified.googleSub, lastLoginAt: now },
      });
      if (claimed.count === 0) {
        // Ktoś był szybszy. Jeśli to ten sam `sub` — to nasze konto.
        return this.prisma.user.findUnique({
          where: { googleId: verified.googleSub },
        });
      }
    } catch (error) {
      // Ten sam `sub` właśnie dopisał się gdzie indziej (wyścig z `create`).
      if (!this.isUniqueViolation(error)) throw error;
      return this.prisma.user.findUnique({
        where: { googleId: verified.googleSub },
      });
    }
    this.logger.log(`Google sign-in linked to existing user: ${targetId}`);
    return this.prisma.user.findUnique({ where: { id: targetId } });
  }

  /**
   * Kolejne logowanie znanym kontem Google. `authProvider` się NIE zmienia
   * (konto Apple z dopisanym Google zostaje kontem Apple). Adres odświeżamy
   * tylko na kontach założonych przez Google — konto Apple ma swój adres
   * z tokenu Apple i nie wymieniamy go na adres z innego dostawcy.
   */
  private async touchGoogleUser(
    user: { id: string; authProvider: AuthProvider; email: string | null },
    verified: VerifiedGoogleIdentity,
    now: Date,
  ) {
    const data: Prisma.UserUpdateInput = { lastLoginAt: now };
    if (user.authProvider === AuthProvider.GOOGLE && verified.email) {
      if (user.email !== verified.email) data.email = verified.email;
      data.emailVerified = verified.emailVerified;
    }
    return this.prisma.user.update({ where: { id: user.id }, data });
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
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
      const outcome = await this.recoverLostRotation(storedToken, now);
      if (outcome.kind === 'recovered') {
        return {
          accessToken: outcome.accessToken,
          refreshToken: outcome.refreshToken,
        };
      }
      if (outcome.kind === 'replay') {
        this.reportFamilyRevoked(
          storedToken.userId,
          'reuse detected',
          outcome.revokedCount,
        );
      }
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    if (!storedToken || storedToken.expiresAt <= now) {
      // Te dwie odmowy wygladaly w logach IDENTYCZNIE — jako brak wpisu — a
      // znacza zupelnie co innego i prowadza do innych napraw. Token NIEZNANY
      // to albo inna instalacja, albo zmieniony `REFRESH_TOKEN_PEPPER`
      // (wtedy 401 dostaja WSZYSCY naraz i nie ma to nic wspolnego z rotacja).
      // Token WYGASLY to po prostu `REFRESH_TOKEN_DAYS`. Bez tego rozroznienia
      // diagnoza wylogowan zaczyna sie od zgadywania.
      this.logger.warn(
        storedToken
          ? `refresh refused: token expired ${Math.round((now.getTime() - storedToken.expiresAt.getTime()) / 1000)}s ago for user ${storedToken.userId} (REFRESH_TOKEN_DAYS=${this.refreshTokenDays})`
          : 'refresh refused: token unknown — brak wpisu dla tego skrotu (inna instalacja albo zmieniony REFRESH_TOKEN_PEPPER)',
      );
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
      const outcome = afterRace
        ? await this.recoverLostRotation(afterRace, new Date())
        : ({ kind: 'stale' } as const);
      if (outcome.kind === 'recovered') {
        return {
          accessToken: outcome.accessToken,
          refreshToken: outcome.refreshToken,
        };
      }
      if (outcome.kind === 'replay') {
        this.reportFamilyRevoked(
          storedToken.userId,
          'concurrent reuse',
          outcome.revokedCount,
        );
      }
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    await this.prisma.refreshToken.deleteMany({
      where: { userId: storedToken.userId, expiresAt: { lt: now } },
    });

    // Wersja odczytana W transakcji rotacji, pod zamkiem sesji — patrz
    // `lockUserSessions`. Odczyt po transakcji mógł trafić już w wersję
    // podbitą przez równoległe unieważnienie i wydać działający token dostępu
    // sesji, która właśnie została zamknięta.
    const accessToken = await this.signAccessToken(
      storedToken.userId,
      successor.tokenVersion,
    );
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
  ): Promise<{
    rawToken: string;
    tokenHash: string;
    tokenVersion: number;
  } | null> {
    const rawToken = randomBytes(64).toString('hex');
    const successorHash = this.hashRefreshToken(rawToken);
    const expiresAt = new Date(now);
    expiresAt.setDate(expiresAt.getDate() + this.refreshTokenDays);

    return this.prisma.$transaction(async (tx) => {
      await this.lockUserSessions(tx, userId);
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
      const tokenVersion = await this.readTokenVersion(tx, userId);
      return { rawToken, tokenHash: successorHash, tokenVersion };
    });
  }

  /**
   * Zamek sesji użytkownika: `FOR NO KEY UPDATE` na jego wierszu `User`.
   *
   * AUDYT 21.09.2026. Unieważnienie (kasowanie rodziny po replayu,
   * `logoutEverywhere`) robiło `updateMany … where revokedAt: null`. W READ
   * COMMITTED takie zapytanie widzi wiersze z chwili SWOJEGO startu, więc
   * następca wstawiany właśnie przez równoległą rotację albo ratunek nie
   * wpadał pod unieważnienie i przeżywał je — a razem z nim cała sesja, bo
   * tym tokenem da się odświeżać dalej. Sprawdzone e2e: wstrzyknięte
   * wylogowanie w środek rotacji zostawiało jeden żywy token. Napastnik,
   * który odświeża w pętli, miał więc realną szansę przeżyć wykrycie
   * kradzieży.
   *
   * Każda transakcja, która WYDAJE albo UNIEWAŻNIA refresh tokeny tej osoby,
   * bierze ten zamek jako pierwszą blokadę. Szereguje to wydawanie
   * z unieważnianiem: albo unieważnienie startuje po zatwierdzeniu nowego
   * tokenu i go widzi, albo rotacja czeka i jej warunkowy zapis trafia już
   * w token unieważniony. `NO KEY` nie blokuje wstawiania wierszy z kluczem
   * obcym do użytkownika (plan, członkostwa) — to nie jest zamek na konto.
   */
  private async lockUserSessions(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${userId}::uuid FOR NO KEY UPDATE`;
  }

  private async readTokenVersion(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<number> {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { tokenVersion: true },
    });
    return user?.tokenVersion ?? 0;
  }

  /**
   * Unieważnia WSZYSTKO, co ta osoba ma: żywe refresh tokeny dostają
   * `revokedAt` i powód, a tokeny już zrotowane albo ratowane — sam powód.
   *
   * Przepisanie powodu na starych wierszach to poprawka z audytu 21.09.2026.
   * Kasowanie rodziny zostawiało je jako ROTATED/RECOVERED, czyli wciąż
   * „do sprawdzenia”, a nie „martwe”. Ta sama stara kopia tokenu — albo
   * kolejny stary token z tego samego łańcucha — wyzwalała więc kasowanie
   * rodziny PRZY KAŻDYM użyciu: także wtedy, gdy właściciel zdążył się już
   * zalogować od nowa. Kto miał jedną skradzioną kopię, mógł wylogowywać
   * właściciela ze wszystkich urządzeń w kółko, aż do wygaśnięcia tokenu
   * (60 dni). Po przepisaniu `recoverLostRotation` widzi REUSE/LOGOUT
   * i odmawia bez kasowania — to jest ten sam stan, co „już wykryty replay”.
   */
  private async retireAllUserTokens(
    tx: Prisma.TransactionClient,
    userId: string,
    reason: 'REUSE' | 'LOGOUT',
    now: Date,
  ): Promise<number> {
    const live = await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now, revokedReason: reason },
    });
    await tx.refreshToken.updateMany({
      where: { userId, revokedReason: { in: ['ROTATED', 'RECOVERED'] } },
      data: { revokedReason: reason },
    });
    await tx.user.updateMany({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    });
    return live.count;
  }

  /**
   * Replay, ktorego nie tlumaczy zgubiona odpowiedz: cala rodzina refresh
   * tokenow pada. Tokeny DOSTEPU zylyby dalej do konca swojego TTL, wiec
   * `tokenVersion` uniewaznia je natychmiast.
   */
  private reportFamilyRevoked(
    userId: string,
    reason: string,
    revokedCount: number,
  ): void {
    // Otwarty socket nie widzi `tokenVersion` — sprawdza je tylko handshake.
    // Bez tego wykrycie kradzieży zamykało REST, a kanał WS zostawiało
    // otwarty do wygaśnięcia access tokenu (audyt 12.09.2026, P1.9).
    // Wołane PO zatwierdzeniu transakcji, która rodzinę skasowała.
    disconnectRevokedUser(userId);
    this.logger.warn(
      `refresh token ${reason} for user ${userId} — revoked ${revokedCount} active token(s)`,
    );
  }

  /**
   * Wynik proby ratunku. Odmowa ma DWA smaki i to jest sedno poprawki
   * z 13.09.2026 (audyt cyklu zycia sesji):
   *
   *  - `replay` — lancuch sie ROZWIDLIL: nastepca zostal uzyty, czyli para
   *    dotarla do klienta i zyje wlasnym zyciem, a mimo to wraca stary token.
   *    Dwie strony maja dzialajace poswiadczenia. To jedyna sytuacja, w ktorej
   *    mamy DOWOD. Tak samo (cala rodzina: wszystkie urzadzenia +
   *    `tokenVersion`) konczy sie w domyslnym trybie strict zrotowany token,
   *    ktory wraca PO oknie laski — dowodu nie ma, ale nie ma tez czym
   *    odroznic spoznionego telefonu od kopii (patrz `strictReuse`).
   *  - `stale` — token jest martwy, ale nic nie wskazuje na kopie: wylogowany,
   *    wygasly albo juz raz wykryty. Odmawiamy TEMU zadaniu (401) i na tym
   *    koniec.
   *
   * Dotad kazda odmowa kasowala rodzine. Znaczylo to, ze telefon, ktoremu
   * padla siec na dluzej niz okno laski, wylogowywal wlasciciela ze WSZYSTKICH
   * urzadzen i zostawial w logach ostrzezenie o kradziezy tokenu. Kara za brak
   * zasiegu byla ta sama, co za kradziez — a wykrywanie, ktore krzyczy przy
   * kazdym slabym polaczeniu, przestaje cokolwiek znaczyc.
   */
  /**
   * Ratunek dla telefonu, ktory zgubil odpowiedz z rotacji.
   *
   * Warunki (wszystkie naraz):
   *  - token uniewaznila ROTACJA (nie logout i nie wykryty wczesniej replay),
   *  - sam token nie zdazyl wygasnac,
   *  - a nastepca ZYJE i NIKT GO NIE UZYL.
   *
   * Ostatni warunek rozstrzyga W OKNIE laski (`REFRESH_REUSE_GRACE_SECONDS`).
   * PO oknie decyduje `REFRESH_STRICT_REUSE` — patrz `strictReuse`: domyslnie
   * (strict) to juz replay i pada cala rodzina; przy jawnym `false` ratunek
   * przechodzi takze po oknie („recovered COLD" w logu).
   *
   * **Nastepcy NIE uniewazniamy** — i to jest poprawka z 13.09.2026, zmierzona
   * na produkcji. Dotad ratunek "zajmowal" nastepce, kasujac go jako REUSE,
   * na zalozeniu "nieuzyty = nie dotarl do klienta". To zalozenie jest
   * FALSZYWE: swiezo wydany refresh token lezy u klienta nieuzywany tak dlugo,
   * jak dlugo zyje jego access token, czyli do godziny. Log z prod:
   *
   *   12:26:17  POST /auth/refresh 201        <- rotacja, klient dostaje S_A
   *   12:26:17  rotation recovered            <- ratunek dla powtorzenia,
   *                                              kasuje S_A i wydaje S_B
   *   12:26:17  POST /auth/logout 200         <- klient oddaje S_B (ma juz S_A)
   *   16:49:17  reason=REUSE successor=missing <- S_A, zabity przez ratunek
   *   16:49:17  POST /auth/refresh 401 -> wylogowanie
   *
   * Czyli ratunek zabijal token, ktory klient WLASNIE dostal i schowal, a cztery
   * godziny pozniej ten sam klient wygladal z tym tokenem na zlodzieja. Sesja
   * umierala w chwili "ratunku", a uzytkownik dowiadywal sie o tym po godzinie.
   *
   * Jednorazowosc ratunku daje teraz warunkowe zajecie PRZEDSTAWIONEGO tokenu
   * (ROTATED -> RECOVERED): drugie powtorzenie tego samego tokenu nie przejdzie
   * juz przez pierwszy warunek, a dwa rownolegle ratunki nie wydadza dwoch par,
   * bo `updateMany` z warunkiem na `revokedReason` wygrywa tylko jeden.
   * Nastepca zostaje zywy — jesli klient go ma, dziala mu dalej; jesli nie ma,
   * dostal wlasnie swieza pare i stary nastepca umrze sam, z uplywem waznosci.
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
  ): Promise<
    | { kind: 'recovered'; accessToken: string; refreshToken: string }
    | { kind: 'replay'; revokedCount: number }
    | { kind: 'stale' }
  > {
    // Decyzja i wydanie pary zapadają W JEDNEJ transakcji pod zamkiem sesji,
    // na ŚWIEŻYM odczycie przedstawionego tokenu i jego następcy. Dawniej
    // biegły na odczycie sprzed chwili, a para z ratunku powstawała poza
    // transakcją — unieważnienie rodziny albo wylogowanie zewsząd, które
    // wpadło pomiędzy, nie obejmowało jej i sesja przeżywała (audyt
    // 21.09.2026, patrz `lockUserSessions`).
    const decided = await this.prisma.$transaction(async (tx) => {
      await this.lockUserSessions(tx, storedToken.userId);
      const current = await tx.refreshToken.findUnique({
        where: { tokenHash: storedToken.tokenHash },
      });
      if (!current) {
        return { kind: 'stale' } as const;
      }
      const { revokedAt, revokedReason, replacedByHash } = current;
      // Replay kasuje rodzinę W TEJ SAMEJ transakcji, co decyzja: dwa
      // równoległe echa tej samej kopii nie mogą obu uznać „replay" na
      // stanie sprzed kasowania — drugie czeka na zamek i widzi już REUSE.
      const replay = async () =>
        ({
          kind: 'replay',
          revokedCount: await this.retireAllUserTokens(
            tx,
            storedToken.userId,
            'REUSE',
            now,
          ),
        }) as const;
      // Kazda odmowa konczy sie kasowaniem rodziny, czyli wylogowaniem — wiec
      // kazda mowi, CO ja wywolalo. Bez tego jedyny slad po wylogowaniu to
      // `reuse detected`, z ktorego nie wynika, ktory warunek nie wyszedl.
      // ROTATED = pierwsze ponowienie, RECOVERED = kolejne. Jedno i drugie to
      // ten sam telefon pukajacy po odpowiedz, ktorej nie dostal — URLSession
      // ponawia POST tyle razy, ile trzeba, a nie raz. Zmierzone e2e: przy
      // TRZECIM ponowieniu stary warunek (`!== 'ROTATED'`) odmawial ratunku
      // i kasowal cala rodzine, czyli wylogowywal ze wszystkich urzadzen za to,
      // ze siec byla slaba. Okna laski to nie przedluza: `revokedAt` jest
      // ustawiane RAZ, przy rotacji, i ratunek go nie rusza — wiec wszystkie
      // ponowienia mieszcza sie w tym samym, nieruchomym oknie.
      const rotatedOrRecovered =
        revokedReason === 'ROTATED' || revokedReason === 'RECOVERED';
      if (!rotatedOrRecovered || !revokedAt || !replacedByHash) {
        // LOGOUT, REUSE (rodzina juz padla) albo rotacja bez wskaznika na
        // nastepce. Zadne z tego nie jest dowodem kopii: wylogowany token wraca
        // po prostu z ponowionego zadania, a raz wykryty replay nie ma juz czego
        // kasowac drugi raz.
        this.logger.warn(
          `rotation recovery refused for user ${storedToken.userId}: reason=${revokedReason ?? 'NULL'} successor=${replacedByHash ? 'set' : 'missing'} — odmowa bez kasowania rodziny`,
        );
        return { kind: 'stale' } as const;
      }
      const ageMs = now.getTime() - revokedAt.getTime();
      if (current.expiresAt <= now) {
        this.logger.warn(
          `rotation recovery refused for user ${storedToken.userId}: token expired`,
        );
        return { kind: 'stale' } as const;
      }

      // NAJPIERW NASTĘPCA, POTEM ZEGAR.
      //
      // Następca żywy i nieużyty znaczy, że nowa para PRAWDOPODOBNIE nie doszła
      // do nikogo — ale tylko prawdopodobnie: świeży refresh token leży u
      // klienta nieużywany do końca życia access tokenu, więc „nieużyty" nie
      // dowodzi „niedostarczony". Dlatego po oknie łaski domyślnie (strict)
      // nie ratujemy; niżej historia trybu łagodnego i jego cena.
      //
      // Zegar był tu do 18.09.2026 jedynym kryterium i wylogowywał właścicieli.
      // Droga, którą przechodzili: cichy push budzi aplikację w tle,
      // ta woła `/auth/refresh`, serwer rotuje token — i iOS zawiesza proces,
      // zanim odpowiedź zdąży trafić do Keychaina (`completionHandler` pusha
      // wraca od razu, więc system ma prawo uśpić aplikację w każdej chwili).
      // W telefonie zostaje token poprzedni. Przez kilka dni nic tego nie
      // wykrywa, bo nikt aplikacji nie otwiera. Po tych kilku dniach pierwsze
      // uruchomienie pokazuje serwerowi token zrotowany dawno temu — i dostaje
      // za to `replay`, czyli skasowanie rodziny, podbicie `tokenVersion`
      // i wylogowanie ZE WSZYSTKICH urządzeń. Kara za to, że telefon leżał
      // w szufladzie.
      //
      // Tryb łagodny (`REFRESH_STRICT_REUSE=false`) to naprawia, ale jego cena
      // jest realna i trzeba ją nazwać: ktoś, kto wszedł w posiadanie STAREGO,
      // już zrotowanego tokenu, którego następcy nikt jeszcze nie użył, dostaje
      // świeżą parę — i ZOSTAJE, bo ta para nie jest spięta z łańcuchem, więc
      // późniejsze użycie następcy przez właściciela niczego nie wykrywa
      // (`test/auth-refresh-after-grace.e2e-spec.ts`, test „KOSZT"). W strict
      // taka próba wylogowuje wszystkich: złodzieja też, ale razem z właścicielem
      // i przy każdej zgubionej odpowiedzi starszej niż okno. Od 21.09.2026
      // domyślny jest strict; właściwą naprawą „telefonu w szufladzie" jest
      // klient, który nie gubi rotacji, nie luźniejszy serwer.
      //
      // Czego żaden tryb NIE rusza: rozwidlonego łańcucha (następca użyty albo
      // unieważniony) niżej. To jedyny przypadek z DOWODEM na dwie działające
      // kopie i tam rodzina dalej pada.
      const successorToken = await tx.refreshToken.findUnique({
        where: { tokenHash: replacedByHash },
        select: { revokedAt: true, revokedReason: true },
      });
      // Następca zgaszony WYLOGOWANIEM nie jest dowodem kopii: nie był
      // nigdy użyty do odświeżenia, więc łańcuch się nie rozwidlił. Tak
      // wygląda iOS, który oddał przez /auth/logout świeży token (Keychain
      // zmienił się w trakcie), a URLSession ponowił POST poprzednikiem.
      // Dotąd to kasowało rodzinę: wylogowanie ze WSZYSTKICH urządzeń,
      // podbite `tokenVersion` i fałszywy alarm o kradzieży (audyt
      // 21.09.2026). Teraz 401 tylko temu żądaniu.
      //
      // Warunek `ROTATED`, nie `RECOVERED`: z tokenu RATOWANEGO wyszła para
      // niepowiązana z łańcuchem, a nie wiemy, kto ją trzyma. Kopia, która
      // wymusiła ratunek i wylogowała następcę, zatrzymałaby ją sobie —
      // dlatego tam rodzina dalej pada.
      if (
        successorToken?.revokedReason === 'LOGOUT' &&
        revokedReason === 'ROTATED'
      ) {
        this.logger.warn(
          `rotation recovery refused for user ${storedToken.userId}: successor logged out — odmowa bez kasowania rodziny`,
        );
        return { kind: 'stale' } as const;
      }
      if (!successorToken || successorToken.revokedAt) {
        // Lancuch sie rozwidlil — rodzina pada w OBU trybach.
        this.logger.warn(
          `rotation recovery refused for user ${storedToken.userId}: successor already used or revoked — lancuch rozwidlony`,
        );
        return replay();
      }

      if (ageMs > this.refreshReuseGraceMs) {
        if (this.strictReuse) {
          this.logger.warn(
            `rotation recovery refused for user ${storedToken.userId}: rotated ${Math.round(ageMs / 1000)}s ago, grace ${this.refreshReuseGraceMs / 1000}s, strict reuse (REFRESH_STRICT_REUSE != false)`,
          );
          return replay();
        }
        // Tylko przy jawnym `REFRESH_STRICT_REUSE=false`.
        // Ratunek „na zimno": telefon wrócił po dniach z tokenem, którego
        // następcy nikt nigdy nie użył. Osobny poziom logu, bo to jest sygnał
        // diagnostyczny — jeśli takich wpisów jest dużo, to znaczy, że klient
        // systematycznie gubi rotacje i trzeba naprawić JEGO, a nie poszerzać
        // okno po stronie serwera.
        this.logger.warn(
          `refresh token rotation recovered COLD for user ${storedToken.userId}: rotated ${Math.round(ageMs / 1000)}s ago (grace ${this.refreshReuseGraceMs / 1000}s), successor never used — klient zgubil odpowiedz z rotacji`,
        );
      }

      // Slad, ze ta rotacja byla juz ratowana. Nie jest to blokada — granice
      // stawia STAN LANCUCHA (nastepca uzyty = rozwidlenie = koniec rodziny),
      // a nie licznik ratunkow. Blokada na liczniku wygladala rozsadnie, dopoki
      // e2e nie pokazalo, ze trzecie ponowienie tego samego zadania konczy sie
      // wylogowaniem — a telefon nie ma jak wiedziec, ktore z jego ponowien
      // serwer juz obsluzyl.
      // Zajęcie WARUNKOWE (stan sprawdzony wyżej, pod zamkiem), w tej samej
      // transakcji co nowa para i odczyt wersji dla tokenu dostępu.
      await tx.refreshToken.updateMany({
        where: {
          tokenHash: storedToken.tokenHash,
          revokedReason: { in: ['ROTATED', 'RECOVERED'] },
        },
        data: { revokedReason: 'RECOVERED' },
      });
      const successor = await this.createRefreshToken(tx, storedToken.userId);
      const tokenVersion = await this.readTokenVersion(tx, storedToken.userId);
      return { kind: 'recovered', successor, tokenVersion } as const;
    });

    if (decided.kind !== 'recovered') {
      return decided;
    }
    const accessToken = await this.signAccessToken(
      storedToken.userId,
      decided.tokenVersion,
    );
    this.logger.log(
      `refresh token rotation recovered for user ${storedToken.userId} - client never received the rotated pair`,
    );
    return {
      kind: 'recovered',
      accessToken,
      refreshToken: decided.successor.rawToken,
    };
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
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { tokenVersion: true },
    });
    return this.signAccessToken(userId, user?.tokenVersion ?? 0);
  }

  private signAccessToken(userId: string, tokenVersion: number) {
    const expiresIn = resolveJwtExpiresIn(process.env.JWT_EXPIRES_IN);
    return this.jwtService.signAsync(
      { sub: userId, tv: tokenVersion },
      { expiresIn },
    );
  }

  /**
   * Wylogowanie ZEWSZĄD (`POST /auth/logout-everywhere`): wszystkie refresh
   * tokeny i wszystkie tokeny dostępu tej osoby przestają działać, a otwarte
   * sockety się rozłączają. Zwykłe `logout` gasi jedno urządzenie.
   *
   * Pod zamkiem sesji i razem z przepisaniem powodu na starych tokenach
   * (`retireAllUserTokens`): token wydany równolegle nie przeżywa wylogowania,
   * a token sprzed wylogowania — nawet taki, który w starym łańcuchu
   * wyglądałby na kopię — daje 401 i nie rusza sesji założonej po nim.
   */
  async logoutEverywhere(userId: string): Promise<{ revokedSessions: number }> {
    const revokedSessions = await this.prisma.$transaction(async (tx) => {
      await this.lockUserSessions(tx, userId);
      return this.retireAllUserTokens(tx, userId, 'LOGOUT', new Date());
    });
    // Wylogowanie ze wszystkich urządzeń musi objąć także kanał WS — patrz
    // `disconnectRevokedUser` (audyt 12.09.2026, P1.9).
    disconnectRevokedUser(userId);
    this.logger.log(
      `logout everywhere for user ${userId} — revoked ${revokedSessions} active token(s)`,
    );
    return { revokedSessions };
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
    return this.createRefreshToken(this.prisma, userId);
  }

  private async createRefreshToken(
    client: Prisma.TransactionClient,
    userId: string,
  ) {
    const rawToken = randomBytes(64).toString('hex');
    const tokenHash = this.hashRefreshToken(rawToken);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + this.refreshTokenDays);

    await client.refreshToken.create({
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
