import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Stary refresh token PO oknie łaski — obie polityki na stanie bazy.
 *
 * `REFRESH_STRICT_REUSE` rozstrzyga, co spotyka zrotowany token, który wraca
 * po oknie, choć jego następcy nikt nie użył:
 *  - strict (DOMYŚLNIE, od 21.09.2026; także brak zmiennej) — replay: pada
 *    cała rodzina i `tokenVersion`;
 *  - łagodny (wyłącznie jawne `false`) — „ratunek na zimno": świeża para,
 *    następca nietknięty.
 *
 * Plik powstał jako diagnoza dwóch testów czerwonych od dcbda1e (18.09.2026),
 * który zrobił tryb łagodny domyślnym i nie zaktualizował e2e. Patrzy na
 * wiersze `RefreshToken`, nie tylko na kod HTTP, i dzięki temu rozróżnia:
 * błąd implementacji (stan łańcucha niespójny z polityką), wyścig (spóźnione
 * żądanie mieści się w oknie wg ZEGARA BAZY) i politykę (przy identycznym
 * stanie łańcucha o wyniku decyduje wyłącznie przełącznik). Ostatni test
 * przypina KOSZT trybu łagodnego — powód, dla którego domyślny jest strict.
 *
 * Bez surowych tokenów i skrótów w logach: wiersze mają etykiety T0, T1, …
 * w kolejności powstania. Ślad na konsoli tylko przy `SESSION_DIAG=1`.
 */
const GRACE_SECONDS = 2;
const GRACE_BEFORE = process.env.REFRESH_REUSE_GRACE_SECONDS;
const STRICT_BEFORE = process.env.REFRESH_STRICT_REUSE;
// Okno czytane RAZ, przy konstrukcji `AuthService` — musi stać przed modułem.
process.env.REFRESH_REUSE_GRACE_SECONDS = String(GRACE_SECONDS);

describe('Refresh token po oknie łaski — diagnoza (e2e, żywa baza)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const createdUserIds: string[] = [];

  type ChainRow = {
    label: string;
    reason: string | null;
    alive: boolean;
    /** Wiek unieważnienia wg ZEGARA BAZY; `null` dla żywego wiersza. */
    revokedAgoMs: number | null;
    successor: string | null;
  };

  const login = async (email?: string) => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: 'Diagnoza sesji',
        email: email ?? `${stamp}@diagnoza.local`,
      })
      .expect(201);
    const body = res.body as {
      refreshToken: string;
      user: { id: string; email: string };
    };
    if (!createdUserIds.includes(body.user.id)) {
      createdUserIds.push(body.user.id);
    }
    return {
      refreshToken: body.refreshToken,
      userId: body.user.id,
      email: email ?? `${stamp}@diagnoza.local`,
    };
  };

  const refresh = (token: string) =>
    request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: token });

  /** Łańcuch tokenów konta — bezpieczny do pokazania. */
  const chain = async (userId: string): Promise<ChainRow[]> => {
    const rows = await prisma.$queryRaw<
      {
        tokenHash: string;
        revokedReason: string | null;
        revokedAt: Date | null;
        replacedByHash: string | null;
        revokedAgoMs: number | null;
      }[]
    >`
      SELECT "tokenHash", "revokedReason", "revokedAt", "replacedByHash",
             (EXTRACT(EPOCH FROM (now() AT TIME ZONE 'UTC' - "revokedAt")) * 1000)::float8 AS "revokedAgoMs"
      FROM "RefreshToken"
      WHERE "userId" = ${userId}::uuid
      ORDER BY "createdAt" ASC, "id" ASC`;
    const labelOf = new Map(rows.map((row, i) => [row.tokenHash, `T${i}`]));
    return rows.map((row) => ({
      label: labelOf.get(row.tokenHash)!,
      reason: row.revokedReason,
      alive: row.revokedAt === null,
      revokedAgoMs:
        row.revokedAgoMs === null ? null : Math.round(row.revokedAgoMs),
      successor: row.replacedByHash
        ? (labelOf.get(row.replacedByHash) ?? '?')
        : null,
    }));
  };

  /** Bez czasów — do porównań; czasy sprawdzamy osobno. */
  const shape = (rows: ChainRow[]) =>
    rows.map((row) =>
      [
        row.label,
        row.alive ? 'ŻYWY' : row.reason,
        row.successor ? `→${row.successor}` : '',
      ]
        .filter(Boolean)
        .join(' '),
    );

  const trace = (title: string, rows: ChainRow[]) => {
    if (process.env.SESSION_DIAG !== '1') return;
    console.info(
      `[diag] ${title}\n` +
        rows
          .map(
            (row) =>
              `        ${row.label}  ${(row.alive ? 'ŻYWY' : row.reason)?.padEnd(9)}  ` +
              `unieważniony ${row.revokedAgoMs ?? '—'} ms temu  następca=${row.successor ?? '—'}`,
          )
          .join('\n'),
    );
  };

  const tokenVersion = async (userId: string) =>
    (
      await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { tokenVersion: true },
      })
    ).tokenVersion;

  const pastGrace = () =>
    new Promise((resolve) => setTimeout(resolve, GRACE_SECONDS * 1000 + 500));

  /**
   * Tryb na czas `run`, jawnie w KAŻDYM przypadku — wynik nie może zależeć
   * od lokalnego środowiska ani od kolejności suit. `undefined` = zmienna
   * nieustawiona (sprawdza wartość domyślną). Sprzątanie w `finally`.
   */
  const inMode = async (
    value: 'true' | 'false' | undefined,
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

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
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
  });

  // ─── Czerwony test nr 1: „ten sam token PO oknie laski" ──────────────────
  //
  // T0 →(rotacja) T1 →(rotacja) T2. Po oknie wraca T1. Następca T1, czyli T2,
  // żyje i nikt go nie użył.

  describe.each([
    { mode: 'false' as const, strict: false, status: 201 },
    { mode: 'true' as const, strict: true, status: 401 },
    { mode: undefined, strict: true, status: 401 },
  ])(
    'scenariusz 1 (wraca T1, następca T2 nieużyty), REFRESH_STRICT_REUSE=$mode',
    ({ mode, strict, status }) => {
      it(`po oknie serwer odpowiada ${status}, a stan łańcucha jest spójny z tą polityką`, async () => {
        await inMode(mode, async () => {
          const session = await login();
          const first = await refresh(session.refreshToken).expect(201);
          const t1 = (first.body as { refreshToken: string }).refreshToken;
          const second = await refresh(t1).expect(201);
          const t2 = (second.body as { refreshToken: string }).refreshToken;
          const versionBefore = await tokenVersion(session.userId);

          await pastGrace();
          const before = await chain(session.userId);
          trace(
            `scenariusz 1, strict=${strict} — PRZED spóźnionym żądaniem`,
            before,
          );

          // Stan wyjściowy jest ten sam w obu trybach…
          expect(shape(before)).toEqual([
            'T0 ROTATED →T1',
            'T1 ROTATED →T2',
            'T2 ŻYWY',
          ]);
          // …i żądanie jest NAPRAWDĘ po oknie — wg zegara bazy, nie testu.
          // To wyklucza hipotezę (b): 201 nie bierze się z tego, że 2,5 s
          // „zmieściło się" w oknie.
          const t1AgeMs = before[1].revokedAgoMs!;
          expect(t1AgeMs).toBeGreaterThan(GRACE_SECONDS * 1000);

          await refresh(t1).expect(status);

          const after = await chain(session.userId);
          trace(`scenariusz 1, strict=${strict} — PO (HTTP ${status})`, after);

          if (!strict) {
            // Polityka od 18.09.2026: ratunek „na zimno". T1 oznaczony jako
            // RECOVERED, następca nietknięty, rodzina i tokeny dostępu żyją.
            expect(shape(after)).toEqual([
              'T0 ROTATED →T1',
              'T1 RECOVERED →T2',
              'T2 ŻYWY',
              'T3 ŻYWY',
            ]);
            expect(await tokenVersion(session.userId)).toBe(versionBefore);
            await refresh(t2).expect(201);
          } else {
            // Polityka sprzed 18.09.2026 — dokładnie to, czego oczekuje
            // czerwony test: rodzina pada razem z tokenami dostępu.
            // Od audytu 21.09.2026 kasowanie rodziny przepisuje powód także
            // na starych, zrotowanych wierszach (wskaźniki zostają): inaczej
            // każde kolejne użycie T0/T1 kasowałoby rodzinę od nowa.
            expect(shape(after)).toEqual([
              'T0 REUSE →T1',
              'T1 REUSE →T2',
              'T2 REUSE',
            ]);
            expect(await tokenVersion(session.userId)).toBe(versionBefore + 1);
            await refresh(t2).expect(401);
          }
          // `revokedAt` T1 nie drgnął — ratunek nie przesuwa okna.
          expect(after[1].revokedAgoMs!).toBeGreaterThanOrEqual(t1AgeMs);
        });
      }, 20_000);
    },
  );

  // ─── Czerwony test nr 2: „token PO OKNIE laski nadal kasuje rodzine" ─────
  //
  // Urządzenie A: T0 →(rotacja) T2; urządzenie B ma własny T1. Po oknie wraca T0.

  describe.each([
    { mode: 'false' as const, strict: false, status: 201 },
    { mode: 'true' as const, strict: true, status: 401 },
    { mode: undefined, strict: true, status: 401 },
  ])(
    'scenariusz 2 (wraca T0, drugie urządzenie w tle), REFRESH_STRICT_REUSE=$mode',
    ({ mode, strict, status }) => {
      it(`po oknie serwer odpowiada ${status}; drugie urządzenie ${strict ? 'pada razem z rodziną' : 'pracuje dalej'}`, async () => {
        await inMode(mode, async () => {
          const session = await login();
          const deviceB = (await login(session.email)).refreshToken;
          const first = await refresh(session.refreshToken).expect(201);
          const t2 = (first.body as { refreshToken: string }).refreshToken;

          await pastGrace();
          const before = await chain(session.userId);
          trace(`scenariusz 2, strict=${strict} — PRZED`, before);
          expect(shape(before)).toEqual([
            'T0 ROTATED →T2',
            'T1 ŻYWY',
            'T2 ŻYWY',
          ]);
          expect(before[0].revokedAgoMs!).toBeGreaterThan(GRACE_SECONDS * 1000);

          await refresh(session.refreshToken).expect(status);
          trace(
            `scenariusz 2, strict=${strict} — PO (HTTP ${status})`,
            await chain(session.userId),
          );

          await refresh(t2).expect(status);
          await refresh(deviceB).expect(status);
        });
      }, 20_000);
    },
  );

  // ─── Czego zmiana z 18.09 NIE ruszyła ─────────────────────────────────────

  it('rozwidlony łańcuch kasuje rodzinę także PO oknie i w trybie domyślnym — wykrywanie replayu zostało', async () => {
    await inMode('false', async () => {
      const session = await login();
      const first = await refresh(session.refreshToken).expect(201);
      const t1 = (first.body as { refreshToken: string }).refreshToken;
      // Następca UŻYTY: para dotarła i żyje własnym życiem.
      const second = await refresh(t1).expect(201);
      const t2 = (second.body as { refreshToken: string }).refreshToken;
      const versionBefore = await tokenVersion(session.userId);

      await pastGrace();
      await refresh(session.refreshToken).expect(401);

      // Stare wiersze też REUSE (audyt 21.09.2026) — echo nie kasuje drugi raz.
      expect(shape(await chain(session.userId))).toEqual([
        'T0 REUSE →T1',
        'T1 REUSE →T2',
        'T2 REUSE',
      ]);
      expect(await tokenVersion(session.userId)).toBe(versionBefore + 1);
      await refresh(t2).expect(401);
    });
  }, 20_000);

  // ─── Koszt polityki domyślnej — materiał do decyzji ───────────────────────

  it('KOSZT trybu domyślnego: kopia starego tokenu po oknie dostaje sesję, której późniejsze użycie następcy przez właściciela JUŻ NIE wykrywa', async () => {
    await inMode('false', async () => {
      const session = await login();
      // Właściciel rotuje i chowa T1. Nie używa go, dopóki żyje access token.
      const owner = await refresh(session.refreshToken).expect(201);
      const ownerToken = (owner.body as { refreshToken: string }).refreshToken;
      const versionBefore = await tokenVersion(session.userId);

      await pastGrace();
      // Ktoś z kopią T0 (zrotowanego, następca nieużyty) puka po oknie.
      const copy = await refresh(session.refreshToken).expect(201);
      const copyToken = (copy.body as { refreshToken: string }).refreshToken;

      // Właściciel wraca i używa swojego T1 — to byłby moment „rozwidlenia",
      // ale świeża para z ratunku nie jest spięta z łańcuchem, więc nic go
      // nie wykrywa: obie strony pracują dalej, bez ostrzeżenia w danych.
      await refresh(ownerToken).expect(201);
      await refresh(copyToken).expect(201);

      const after = await chain(session.userId);
      trace('koszt trybu domyślnego — PO', after);
      expect(after.filter((row) => row.alive)).toHaveLength(2);
      expect(after.some((row) => row.reason === 'REUSE')).toBe(false);
      expect(await tokenVersion(session.userId)).toBe(versionBefore);
    });
  }, 20_000);
});
