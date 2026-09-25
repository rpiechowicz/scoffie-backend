import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuthService } from '../src/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * AUDYT CYKLU ŻYCIA SESJI 21.09.2026 — czternaście scenariuszy, każdy ze
 * STANEM BAZY po operacji, nie tylko z kodem odpowiedzi.
 *
 * `auth-session-lifecycle.e2e-spec.ts` i `auth-refresh-after-grace.e2e-spec.ts`
 * przypinają politykę (strict/łagodny, okno łaski). Ten plik przypina to,
 * czego tamte nie oglądają:
 *  - co DOKŁADNIE leży w `RefreshToken` i `User.tokenVersion` po każdej ścieżce,
 *  - że unieważnienie rodziny / wylogowanie zewsząd nie przegrywa wyścigu
 *    z równoległą rotacją ani ratunkiem (token wybity w trakcie nie przeżywa),
 *  - że stara kopia tokenu wyzwala kasowanie rodziny RAZ, a nie za każdym
 *    razem — także po `logout-everywhere`,
 *  - że `POST /auth/logout-everywhere` istnieje i robi to, co obiecuje,
 *  - że w logach i błędach nie ma surowych tokenów ani sekretów.
 */
const GRACE_BEFORE = process.env.REFRESH_REUSE_GRACE_SECONDS;
process.env.REFRESH_REUSE_GRACE_SECONDS = '2';
const STRICT_BEFORE = process.env.REFRESH_STRICT_REUSE;
delete process.env.REFRESH_STRICT_REUSE;
const NODE_ENV_BEFORE = process.env.NODE_ENV;
// Kilkadziesiąt `/auth/dev` i `/auth/refresh` z jednego IP w minutę — limit
// logowania (20/min) to przedmiot `throttling.e2e-spec.ts`, nie tej suity.
// Throttler czyta limit per żądanie, więc wystarczy ustawić go tutaj.
const AUTH_LIMIT_BEFORE = process.env.THROTTLE_AUTH_LIMIT;
process.env.THROTTLE_AUTH_LIMIT = '10000';

type Session = {
  accessToken: string;
  refreshToken: string;
  userId: string;
  email: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Audyt cyklu życia sesji 21.09.2026 (e2e, żywa baza)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  const createdUserIds: string[] = [];

  const login = async (label: string, email?: string): Promise<Session> => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const address = email ?? `sesja-${label}-${stamp}@audit.local`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({ displayName: `Sesja ${label}`, email: address })
      .expect(201);
    const userId = res.body.user.id as string;
    if (!createdUserIds.includes(userId)) createdUserIds.push(userId);
    return {
      accessToken: res.body.accessToken as string,
      refreshToken: res.body.refreshToken as string,
      userId,
      email: address,
    };
  };

  const refresh = (token: string) =>
    request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: token });

  const logout = (token: string) =>
    request(app.getHttpServer())
      .post('/auth/logout')
      .send({ refreshToken: token });

  const logoutEverywhere = (accessToken?: string) => {
    const req = request(app.getHttpServer()).post('/auth/logout-everywhere');
    return accessToken
      ? req.set('Authorization', `Bearer ${accessToken}`)
      : req;
  };

  const accessWorks = async (accessToken: string): Promise<boolean> => {
    const res = await request(app.getHttpServer())
      .get('/me/consents')
      .set('Authorization', `Bearer ${accessToken}`);
    return res.status === 200;
  };

  const rows = (userId: string) =>
    prisma.refreshToken.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

  const alive = (userId: string) =>
    prisma.refreshToken.count({ where: { userId, revokedAt: null } });

  const tokenVersion = async (userId: string) =>
    (
      await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { tokenVersion: true },
      })
    ).tokenVersion;

  const reasons = async (userId: string) =>
    (await rows(userId)).map((row) => row.revokedReason ?? 'ALIVE').sort();

  const withEnv = async (
    values: Record<string, string | undefined>,
    run: () => Promise<void>,
  ) => {
    const before = Object.fromEntries(
      Object.keys(values).map((key) => [key, process.env[key]]),
    );
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      await run();
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  const pastGraceWindow = () => sleep(2_500);

  /**
   * Wstrzykuje `action` TUŻ PRZED zapisem nowego refresh tokenu — zarówno
   * w transakcji (`tx.refreshToken.create`), jak i poza nią. Tak odtwarza się
   * wyścig deterministycznie: unieważnienie startuje w chwili, w której
   * rotacja/ratunek już sprawdziły warunki, a jeszcze nie zapisały następcy.
   * `action` NIE jest awaitowane (ma prawo czekać na blokadę), wynik wraca
   * przez `settled()`.
   */
  const injectBeforeTokenCreate = (action: () => Promise<unknown>) => {
    let fired = false;
    let pending: Promise<unknown> = Promise.resolve();
    const fire = async () => {
      if (fired) return;
      fired = true;
      pending = action().catch((error: unknown) => error);
      // Czas na to, żeby unieważnienie doszło do swoich zapytań (albo stanęło
      // na blokadzie), zanim następca w ogóle powstanie.
      await sleep(300);
    };

    const delegate = prisma.refreshToken;
    const originalCreate = delegate.create.bind(delegate);
    const createSpy = jest
      .spyOn(delegate, 'create')
      .mockImplementation(((args: never) =>
        fire().then(() => originalCreate(args))) as never);

    const originalTransaction = prisma.$transaction.bind(prisma);
    const txSpy = jest.spyOn(prisma, '$transaction').mockImplementation(((
      arg: unknown,
      options: unknown,
    ) => {
      if (typeof arg !== 'function') {
        return originalTransaction(arg as never, options as never);
      }
      const run = arg as (tx: unknown) => Promise<unknown>;
      return originalTransaction(
        ((tx: Record<string, unknown>) => {
          const proxied = new Proxy(tx, {
            get(target, prop, receiver) {
              if (prop !== 'refreshToken') {
                return Reflect.get(target, prop, receiver);
              }
              const inner = target.refreshToken as Record<string, unknown>;
              return new Proxy(inner, {
                get(innerTarget, innerProp) {
                  if (innerProp !== 'create') {
                    return Reflect.get(innerTarget, innerProp);
                  }
                  return async (args: unknown) => {
                    await fire();
                    return (
                      innerTarget.create as (a: unknown) => Promise<unknown>
                    )(args);
                  };
                },
              });
            },
          });
          return run(proxied);
        }) as never,
        options as never,
      );
    }) as never);

    return {
      fired: () => fired,
      settled: async () => {
        await pending;
        createSpy.mockRestore();
        txSpy.mockRestore();
      },
    };
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
  }, 60_000);

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('REFRESH_REUSE_GRACE_SECONDS', GRACE_BEFORE);
    restore('REFRESH_STRICT_REUSE', STRICT_BEFORE);
    restore('NODE_ENV', NODE_ENV_BEFORE);
    restore('THROTTLE_AUTH_LIMIT', AUTH_LIMIT_BEFORE);
  });

  // ─── 1. Poprawny refresh ─────────────────────────────────────────────────
  it('1. poprawny refresh: poprzednik ROTATED ze wskaźnikiem na JEDYNEGO żywego następcę, w bazie same hasze', async () => {
    const session = await login('poprawny');
    const before = await tokenVersion(session.userId);

    const res = await refresh(session.refreshToken).expect(201);
    expect(res.body.refreshToken).not.toBe(session.refreshToken);
    expect(await accessWorks(res.body.accessToken as string)).toBe(true);

    const all = await rows(session.userId);
    expect(all).toHaveLength(2);
    const rotated = all.find((row) => row.revokedReason === 'ROTATED');
    const living = all.filter((row) => row.revokedAt === null);
    expect(living).toHaveLength(1);
    expect(rotated?.revokedAt).toBeInstanceOf(Date);
    expect(rotated?.replacedByHash).toBe(living[0].tokenHash);
    expect(living[0].replacedByHash).toBeNull();
    expect(living[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
    // Surowy token nigdy nie leży w bazie — tylko sha256 z pieprzem.
    for (const row of all) {
      expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect([session.refreshToken, res.body.refreshToken]).not.toContain(
        row.tokenHash,
      );
    }
    expect(await tokenVersion(session.userId)).toBe(before);
  });

  // ─── 2, 9. Replay po rotacji → cała rodzina ──────────────────────────────
  it('2/9. stary token po tym, jak łańcuch poszedł dalej: 401, CAŁA rodzina REUSE, tokenVersion +1, access tokeny martwe', async () => {
    const session = await login('replay');
    const secondDevice = await login('replay-b', session.email);
    const before = await tokenVersion(session.userId);

    const first = await refresh(session.refreshToken).expect(201);
    const second = await refresh(first.body.refreshToken as string).expect(201);

    await refresh(session.refreshToken).expect(401);

    expect(await alive(session.userId)).toBe(0);
    expect(await tokenVersion(session.userId)).toBe(before + 1);
    expect(await accessWorks(second.body.accessToken as string)).toBe(false);
    expect(await accessWorks(secondDevice.accessToken)).toBe(false);
    await refresh(second.body.refreshToken as string).expect(401);
    await refresh(secondDevice.refreshToken).expect(401);
    // Żywe w chwili wykrycia dostały REUSE; nic nie zostało bez powodu.
    expect(
      (await rows(session.userId)).every((row) => row.revokedReason !== null),
    ).toBe(true);
  });

  // ─── 3, 6. Strict po oknie; 4. łagodny ───────────────────────────────────
  it.each([
    ['zmienna nieustawiona', undefined],
    ['pusta', ''],
    ['true', 'true'],
    ['literówka „flase"', 'flase'],
    ['0', '0'],
    ['no', 'no'],
    ['off', 'off'],
  ])(
    '3/6. STRICT (%s): retry PO oknie łaski = 401 i cała rodzina pada',
    async (_label, value) => {
      await withEnv({ REFRESH_STRICT_REUSE: value }, async () => {
        const session = await login('strict');
        const secondDevice = await login('strict-b', session.email);
        const before = await tokenVersion(session.userId);
        await refresh(session.refreshToken).expect(201);
        await pastGraceWindow();

        await refresh(session.refreshToken).expect(401);

        expect(await alive(session.userId)).toBe(0);
        expect(await tokenVersion(session.userId)).toBe(before + 1);
        await refresh(secondDevice.refreshToken).expect(401);
      });
    },
    15_000,
  );

  it.each(['production', 'development', 'test', 'staging'])(
    '3. NODE_ENV=%s niczego nie luzuje: bez jawnego false obowiązuje strict',
    async (nodeEnv) => {
      await withEnv(
        { REFRESH_STRICT_REUSE: undefined, NODE_ENV: nodeEnv },
        async () => {
          const session = await login(`env-${nodeEnv}`);
          await refresh(session.refreshToken).expect(201);
          await pastGraceWindow();
          await refresh(session.refreshToken).expect(401);
          expect(await alive(session.userId)).toBe(0);
        },
      );
    },
    15_000,
  );

  it.each(['false', ' FALSE '])(
    '4. ŁAGODNY tylko przy jawnym %p: retry po oknie = 201, rodzina i tokenVersion nietknięte',
    async (value) => {
      await withEnv({ REFRESH_STRICT_REUSE: value }, async () => {
        const session = await login('lagodny');
        const secondDevice = await login('lagodny-b', session.email);
        const before = await tokenVersion(session.userId);
        await refresh(session.refreshToken).expect(201);
        await pastGraceWindow();

        const cold = await refresh(session.refreshToken).expect(201);

        expect(await tokenVersion(session.userId)).toBe(before);
        expect(await reasons(session.userId)).toEqual([
          'ALIVE', // drugie urządzenie
          'ALIVE', // następca z rotacji
          'ALIVE', // para z ratunku
          'RECOVERED',
        ]);
        await refresh(secondDevice.refreshToken).expect(201);
        await refresh(cold.body.refreshToken as string).expect(201);
      });
    },
    15_000,
  );

  it('4. ŁAGODNY nie rusza rozwidlenia: użyty następca = 401 i rodzina pada także przy false', async () => {
    await withEnv({ REFRESH_STRICT_REUSE: 'false' }, async () => {
      const session = await login('lagodny-rozwidlenie');
      const first = await refresh(session.refreshToken).expect(201);
      await refresh(first.body.refreshToken as string).expect(201);
      await pastGraceWindow();
      await refresh(session.refreshToken).expect(401);
      expect(await alive(session.userId)).toBe(0);
    });
  }, 15_000);

  // ─── 5. Zgubiona odpowiedź, retry w oknie ────────────────────────────────
  it('5. retry W OKNIE: 201, przedstawiony token RECOVERED, następca i para z ratunku żywe, nic nie pada', async () => {
    const session = await login('grace');
    const before = await tokenVersion(session.userId);
    const first = await refresh(session.refreshToken).expect(201);

    const retry = await refresh(session.refreshToken).expect(201);

    expect(retry.body.refreshToken).not.toBe(first.body.refreshToken);
    expect(await reasons(session.userId)).toEqual([
      'ALIVE',
      'ALIVE',
      'RECOVERED',
    ]);
    const recovered = (await rows(session.userId)).find(
      (row) => row.revokedReason === 'RECOVERED',
    );
    // `revokedAt` zostaje z ROTACJI — ratunek nie przesuwa okna łaski.
    expect(recovered?.replacedByHash).not.toBeNull();
    expect(await tokenVersion(session.userId)).toBe(before);
    expect(await accessWorks(retry.body.accessToken as string)).toBe(true);
  });

  // ─── 7, 14. Równoległe refreshe ──────────────────────────────────────────
  it('7/14. osiem równoległych żądań tym samym tokenem: jedna rotacja, zero 5xx, żywych tokenów tyle, ile wydanych par', async () => {
    const session = await login('rownolegle');
    const before = await tokenVersion(session.userId);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => refresh(session.refreshToken)),
    );

    const statuses = results.map((res) => res.status);
    expect(statuses.every((status) => status === 201 || status === 401)).toBe(
      true,
    );
    const issued = results
      .filter((res) => res.status === 201)
      .map((res) => res.body.refreshToken as string);
    expect(issued.length).toBeGreaterThan(0);
    expect(new Set(issued).size).toBe(issued.length);

    const all = await rows(session.userId);
    // Przedstawiony token unieważniony DOKŁADNIE raz i ma jednego następcę.
    const presented = all.filter((row) => row.replacedByHash !== null);
    expect(presented).toHaveLength(1);
    expect(['ROTATED', 'RECOVERED']).toContain(presented[0].revokedReason);
    expect(all.filter((row) => row.revokedAt === null)).toHaveLength(
      issued.length,
    );
    expect(all).toHaveLength(issued.length + 1);
    expect(await tokenVersion(session.userId)).toBe(before);
  });

  it('7. dwa RÓŻNE urządzenia odświeżają równolegle: dwa niezależne łańcuchy, żaden nie rusza drugiego', async () => {
    const a = await login('dwa-urzadzenia');
    const b = await login('dwa-urzadzenia-b', a.email);

    const [ra, rb] = await Promise.all([
      refresh(a.refreshToken),
      refresh(b.refreshToken),
    ]);
    expect([ra.status, rb.status]).toEqual([201, 201]);
    expect(await reasons(a.userId)).toEqual([
      'ALIVE',
      'ALIVE',
      'ROTATED',
      'ROTATED',
    ]);
    await refresh(ra.body.refreshToken as string).expect(201);
    await refresh(rb.body.refreshToken as string).expect(201);
  });

  // ─── 8. Następca bez użycia poprzednika / para z ratunku ─────────────────
  it('8. następca działa bez względu na to, czy para z ratunku była użyta — i odwrotnie; łańcuch zostaje spójny', async () => {
    const session = await login('nastepca');
    const first = await refresh(session.refreshToken).expect(201);
    const retry = await refresh(session.refreshToken).expect(201);

    // Klient schował parę z ratunku i idzie nią dalej; następcy nie tknął.
    const viaRecovery = await refresh(retry.body.refreshToken as string).expect(
      201,
    );
    // Następca z rotacji nadal jest pełnoprawnym tokenem.
    await refresh(first.body.refreshToken as string).expect(201);
    expect(await alive(session.userId)).toBe(2);
    await refresh(viaRecovery.body.refreshToken as string).expect(201);
  });

  it('8. token, którego NIGDY nie wydaliśmy (zgadnięty „następca"): 401, zero zmian w bazie', async () => {
    const session = await login('zgadywany');
    const snapshot = JSON.stringify(await rows(session.userId));
    await refresh('f'.repeat(128)).expect(401);
    expect(JSON.stringify(await rows(session.userId))).toBe(snapshot);
  });

  // ─── 10. logout ──────────────────────────────────────────────────────────
  it('10. logout: ten jeden wiersz LOGOUT, refresh nim = 401 bez kasowania rodziny, drugie urządzenie i tokenVersion nietknięte', async () => {
    const session = await login('logout');
    const secondDevice = await login('logout-b', session.email);
    const before = await tokenVersion(session.userId);

    const res = await logout(session.refreshToken).expect(200);
    expect(res.body).toEqual({ revoked: true });
    // Idempotentne i bez zdradzania, czy token istniał.
    expect((await logout(session.refreshToken).expect(200)).body).toEqual({
      revoked: false,
    });
    expect((await logout('e'.repeat(128)).expect(200)).body).toEqual({
      revoked: false,
    });

    expect(await reasons(session.userId)).toEqual(['ALIVE', 'LOGOUT']);
    await refresh(session.refreshToken).expect(401);
    expect(await tokenVersion(session.userId)).toBe(before);
    await refresh(secondDevice.refreshToken).expect(201);
  });

  it('10. logout ŚWIEŻEGO następcy + spóźnione ponowienie poprzednika: 401, ale drugie urządzenie żyje', async () => {
    // iOS potrafi oddać przez /auth/logout token, który dopiero co dostał
    // (Keychain zmienił się w trakcie), a URLSession ponawia POST /refresh.
    // Następca zgaszony WYLOGOWANIEM to nie dowód kopii — rodzina ma zostać.
    const session = await login('logout-nastepcy');
    const secondDevice = await login('logout-nastepcy-b', session.email);
    const before = await tokenVersion(session.userId);
    const first = await refresh(session.refreshToken).expect(201);
    await logout(first.body.refreshToken as string).expect(200);

    await refresh(session.refreshToken).expect(401);

    expect(await tokenVersion(session.userId)).toBe(before);
    await refresh(secondDevice.refreshToken).expect(201);
  });

  // ─── 11, 12. logout-everywhere ───────────────────────────────────────────
  describe('11/12. POST /auth/logout-everywhere', () => {
    it('bez tokenu dostępu i z podrobionym: 401, nic się nie zmienia', async () => {
      const session = await login('le-401');
      await logoutEverywhere().expect(401);
      await logoutEverywhere('eyJhbGciOiJIUzI1NiJ9.e30.podrobiony').expect(401);
      // Refresh token NIE jest poświadczeniem tej trasy.
      await logoutEverywhere(session.refreshToken).expect(401);
      expect(await alive(session.userId)).toBe(1);
    });

    it('gasi WSZYSTKIE sesje: każdy wiersz unieważniony, tokenVersion +1, stare access i refresh tokeny martwe, nowe logowanie działa', async () => {
      const phone = await login('le');
      const tablet = await login('le-b', phone.email);
      const rotated = await refresh(phone.refreshToken).expect(201);
      const before = await tokenVersion(phone.userId);

      const res = await logoutEverywhere(tablet.accessToken).expect(200);
      expect(res.body).toEqual({ revokedSessions: 2 });

      expect(await alive(phone.userId)).toBe(0);
      expect(await tokenVersion(phone.userId)).toBe(before + 1);
      for (const token of [
        phone.accessToken,
        tablet.accessToken,
        rotated.body.accessToken as string,
      ]) {
        expect(await accessWorks(token)).toBe(false);
      }
      // Ten sam access token nie wyloguje drugi raz — sam jest już martwy.
      await logoutEverywhere(tablet.accessToken).expect(401);

      const fresh = await login('le-c', phone.email);
      expect(await accessWorks(fresh.accessToken)).toBe(true);

      // 12. Tokeny sprzed wylogowania — żywe wtedy, zrotowane wtedy — dają 401
      // i NIE ruszają sesji założonej po wylogowaniu.
      const afterLogin = await tokenVersion(phone.userId);
      for (const stale of [
        phone.refreshToken, // zrotowany przed wylogowaniem
        rotated.body.refreshToken as string, // żywy w chwili wylogowania
        tablet.refreshToken,
      ]) {
        await refresh(stale).expect(401);
      }
      expect(await tokenVersion(phone.userId)).toBe(afterLogin);
      expect(await alive(phone.userId)).toBe(1);
      expect(await accessWorks(fresh.accessToken)).toBe(true);
      await refresh(fresh.refreshToken).expect(201);
    });

    it('token DWA kroki wstecz sprzed wylogowania (w starym łańcuchu: „kopia") też nie rusza nowej sesji', async () => {
      const phone = await login('le-dwa-kroki');
      const first = await refresh(phone.refreshToken).expect(201);
      const second = await refresh(first.body.refreshToken as string).expect(
        201,
      );
      await logoutEverywhere(second.body.accessToken as string).expect(200);
      // Stare wiersze dostały powód LOGOUT — nic nie zostało „do sprawdzenia".
      expect(await reasons(phone.userId)).toEqual([
        'LOGOUT',
        'LOGOUT',
        'LOGOUT',
      ]);
      const fresh = await login('le-dwa-kroki-b', phone.email);
      const version = await tokenVersion(phone.userId);

      await refresh(phone.refreshToken).expect(401);
      await refresh(first.body.refreshToken as string).expect(401);

      expect(await tokenVersion(phone.userId)).toBe(version);
      expect(await accessWorks(fresh.accessToken)).toBe(true);
      await refresh(fresh.refreshToken).expect(201);
    });

    it('po oknie łaski, w strict, token sprzed wylogowania nadal nie rusza nowej sesji', async () => {
      const phone = await login('le-po-oknie');
      await refresh(phone.refreshToken).expect(201);
      await logoutEverywhere(phone.accessToken).expect(200);
      const fresh = await login('le-po-oknie-b', phone.email);
      await pastGraceWindow();

      await refresh(phone.refreshToken).expect(401);

      expect(await alive(phone.userId)).toBe(1);
      await refresh(fresh.refreshToken).expect(201);
    }, 15_000);
  });

  // ─── 9 c.d. Kasowanie rodziny wyzwala się RAZ ────────────────────────────
  it('9. ta sama stara kopia wyzwala kasowanie rodziny RAZ: echo nie zabija sesji założonej po wykryciu', async () => {
    const session = await login('echo');
    const first = await refresh(session.refreshToken).expect(201);
    await refresh(first.body.refreshToken as string).expect(201);
    await refresh(session.refreshToken).expect(401); // wykrycie
    expect(await alive(session.userId)).toBe(0);

    // Właściciel loguje się od nowa.
    const fresh = await login('echo-b', session.email);
    const version = await tokenVersion(session.userId);

    // Posiadacz starej kopii (albo telefon, który dopiero teraz się obudził)
    // puka jeszcze raz — i kolejnym starym tokenem z tego samego łańcucha.
    await refresh(session.refreshToken).expect(401);
    await refresh(first.body.refreshToken as string).expect(401);

    expect(await tokenVersion(session.userId)).toBe(version);
    expect(await accessWorks(fresh.accessToken)).toBe(true);
    await refresh(fresh.refreshToken).expect(201);
  });

  it('9. NOWA kradzież po ponownym logowaniu jest dalej wykrywana — jednorazowość dotyczy starego łańcucha, nie konta', async () => {
    const session = await login('nowa-kradziez');
    const first = await refresh(session.refreshToken).expect(201);
    await refresh(first.body.refreshToken as string).expect(201);
    await refresh(session.refreshToken).expect(401);

    const fresh = await login('nowa-kradziez-b', session.email);
    const next = await refresh(fresh.refreshToken).expect(201);
    await refresh(next.body.refreshToken as string).expect(201);
    const version = await tokenVersion(session.userId);

    await refresh(fresh.refreshToken).expect(401);

    expect(await alive(session.userId)).toBe(0);
    expect(await tokenVersion(session.userId)).toBe(version + 1);
  });

  // ─── 14. Unieważnienie kontra równoległe wybicie tokenu ──────────────────
  describe('14. unieważnienie nie przegrywa wyścigu z równoległym wybiciem tokenu', () => {
    it('logoutEverywhere w trakcie ROTACJI: następca nie przeżywa wylogowania', async () => {
      const session = await login('wyscig-rotacja');
      const injection = injectBeforeTokenCreate(() =>
        auth.logoutEverywhere(session.userId),
      );

      const res = await refresh(session.refreshToken);
      await injection.settled();

      expect(injection.fired()).toBe(true);
      expect(await alive(session.userId)).toBe(0);
      if (res.status === 201) {
        await refresh(res.body.refreshToken as string).expect(401);
        expect(await accessWorks(res.body.accessToken as string)).toBe(false);
      }
    });

    it('logoutEverywhere w trakcie RATUNKU (retry w oknie): para z ratunku nie przeżywa wylogowania', async () => {
      const session = await login('wyscig-ratunek');
      await refresh(session.refreshToken).expect(201);
      const injection = injectBeforeTokenCreate(() =>
        auth.logoutEverywhere(session.userId),
      );

      const res = await refresh(session.refreshToken);
      await injection.settled();

      expect(injection.fired()).toBe(true);
      expect(await alive(session.userId)).toBe(0);
      if (res.status === 201) {
        await refresh(res.body.refreshToken as string).expect(401);
      }
    });

    it('wykrycie REPLAY na jednym urządzeniu w trakcie rotacji na drugim: nowy token drugiego nie przeżywa kasowania rodziny', async () => {
      const phone = await login('wyscig-replay');
      const tablet = await login('wyscig-replay-b', phone.email);
      const first = await refresh(phone.refreshToken).expect(201);
      await refresh(first.body.refreshToken as string).expect(201);

      // Tablet rotuje; w połowie jego rotacji przychodzi stara kopia telefonu.
      const injection = injectBeforeTokenCreate(() =>
        refresh(phone.refreshToken).then((res) => res.status),
      );
      const res = await refresh(tablet.refreshToken);
      await injection.settled();

      expect(injection.fired()).toBe(true);
      expect(await alive(phone.userId)).toBe(0);
      if (res.status === 201) {
        await refresh(res.body.refreshToken as string).expect(401);
      }
    });
  });

  // ─── 13. Logi i błędy ────────────────────────────────────────────────────
  it('13. żaden log ani błąd nie niesie surowego tokenu, hasza z bazy ani sekretu', async () => {
    const lines: string[] = [];
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
      (level) =>
        jest
          .spyOn(Logger.prototype, level)
          .mockImplementation((...args: unknown[]) => {
            lines.push(args.map((arg) => String(arg)).join(' '));
          }),
    );
    const bodies: string[] = [];
    const secrets: string[] = [];
    try {
      const session = await login('logi');
      const first = await refresh(session.refreshToken);
      const second = await refresh(first.body.refreshToken as string);
      const replay = await refresh(session.refreshToken); // kasowanie rodziny
      const unknown = await refresh('a'.repeat(128));
      const tooShort = await refresh('krótki');
      const again = await login('logi-b', session.email);
      const out = await logout(again.refreshToken);
      const everywhere = await logoutEverywhere(`${again.accessToken}x`);
      bodies.push(
        ...[replay, unknown, tooShort, out, everywhere].map((res) =>
          JSON.stringify(res.body),
        ),
      );
      secrets.push(
        session.refreshToken,
        session.accessToken,
        first.body.refreshToken as string,
        second.body.refreshToken as string,
        again.refreshToken,
        again.accessToken,
        'a'.repeat(128),
        ...(await rows(session.userId)).map((row) => row.tokenHash),
      );
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    for (const name of ['JWT_SECRET', 'REFRESH_TOKEN_PEPPER']) {
      const value = process.env[name];
      if (value && value.length >= 8) secrets.push(value);
    }

    // Log ma mówić, CO się stało (inaczej test przechodziłby na pustym logu).
    expect(lines.join('\n')).toMatch(/revoked \d+ active token/);
    for (const secret of secrets) {
      for (const text of [...lines, ...bodies]) {
        expect(text).not.toContain(secret);
      }
    }
  });
});
