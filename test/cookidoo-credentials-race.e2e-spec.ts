import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { HouseholdsService } from '../src/households/households.service';
import { CookidooServiceClient } from '../src/integrations/cookidoo-service.client';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Wyścig: zapis poświadczeń Cookidoo kontra usunięcie / wyjście z domu
 * (review 7.10.2026) — dwie transakcje na żywej bazie, deterministycznie.
 *
 * Zapis poświadczeń trzyma `FOR SHARE` na wierszu `Membership` pytającego.
 * Usunięcie członkostwa (`removeMember`, `leave`) czeka więc na jego commit,
 * a sprzątanie `revokeCookidooCredentialsOf` biegnie PO `membership.delete`
 * i widzi zapisany wiersz. Bez blokady albo przy sprzątaniu PRZED usunięciem
 * członkostwa hasło osoby spoza domu zostawało w bazie.
 *
 * Zatrzask: hak w transakcji zapisu — po zapisaniu wiersza, przed commitem —
 * odpala usunięcie z domu i czeka, aż to albo się skończy, albo stanie na
 * blokadzie (`pg_locks.granted = false`). Dopiero wtedy zapis się zatwierdza.
 */
type Session = { accessToken: string; user: { id: string } };

describe('Cookidoo: zapis poświadczeń kontra usunięcie z domu (e2e, dwie transakcje)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let households: HouseholdsService;
  const env = { ...process.env };
  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];
  let owner: Session;
  let wyrzucany: Session;
  let wychodzacy: Session;
  let householdId: string;

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  const devLogin = async (label: string): Promise<Session> => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `${label} ${stamp}`,
        email: `${label.toLowerCase()}-${stamp}@cookidoo-race.local`,
      })
      .expect(201);
    const session = res.body as Session;
    createdUserIds.push(session.user.id);
    return session;
  };

  const connect = (s: Session) =>
    request(app.getHttpServer())
      .post('/integrations/cookidoo/connect')
      .set({ Authorization: `Bearer ${s.accessToken}` })
      .send({ email: 'konto@example.com', password: 'tajne-haslo' });

  /**
   * Odpala `action` W transakcji zapisu poświadczeń, zaraz po zapisaniu
   * wiersza (create/upsert/updateMany), i trzyma commit, aż `action` się
   * skończy albo zawiśnie na blokadzie wiersza.
   */
  const duringCredentialWrite = (action: () => Promise<unknown>) => {
    let fired = false;
    let pending: Promise<unknown> = Promise.resolve();
    let settled = false;
    const fire = async () => {
      if (fired) return;
      fired = true;
      pending = action()
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      for (const deadline = Date.now() + 5_000; Date.now() < deadline;) {
        if (settled) return;
        const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
          SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted`;
        if (waiting > 0) return;
        await sleep(25);
      }
      throw new Error('usunięcie z domu ani się nie skończyło, ani nie czeka');
    };

    const originalTransaction = prisma.$transaction.bind(prisma);
    const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((
      arg: unknown,
      options: unknown,
    ) => {
      if (typeof arg !== 'function') return originalTransaction(arg, options);
      const run = arg as (tx: unknown) => Promise<unknown>;
      return originalTransaction((tx: Record<string, unknown>) => {
        const proxied = new Proxy(tx, {
          get(target, prop, receiver) {
            if (prop !== 'cookidooIntegration') {
              return Reflect.get(target, prop, receiver);
            }
            const inner = target.cookidooIntegration as Record<string, unknown>;
            return new Proxy(inner, {
              get(innerTarget, innerProp) {
                const original = Reflect.get(innerTarget, innerProp) as unknown;
                if (
                  typeof original !== 'function' ||
                  !['create', 'upsert', 'updateMany'].includes(
                    String(innerProp),
                  )
                ) {
                  return original;
                }
                return async (args: unknown) => {
                  const result = await (
                    original as (a: unknown) => Promise<unknown>
                  ).call(innerTarget, args);
                  await fire();
                  return result;
                };
              },
            });
          },
        });
        return run(proxied);
      }, options);
    }) as never);

    return {
      fired: () => fired,
      done: async () => {
        const outcome = await pending;
        spy.mockRestore();
        return outcome;
      },
    };
  };

  const credentials = () =>
    prisma.cookidooIntegration.count({ where: { householdId } });

  beforeAll(async () => {
    process.env.THROTTLE_AUTH_LIMIT = '10000';
    delete process.env.COOKIDOO_INTEGRATION_ENABLED;
    process.env.COOKIDOO_ENCRYPTION_KEY ??=
      'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CookidooServiceClient)
      .useValue({
        validateCredentials: () => Promise.resolve({ subscription: null }),
        addToWeek: () => Promise.resolve({}),
      })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    households = app.get(HouseholdsService);

    owner = await devLogin('Wlasciciel');
    wyrzucany = await devLogin('Wyrzucany');
    wychodzacy = await devLogin('Wychodzacy');
    for (const s of [owner, wyrzucany, wychodzacy]) {
      await prisma.membership.deleteMany({ where: { userId: s.user.id } });
    }
    const household = await prisma.household.create({
      data: { name: `Dom wyścigu ${Date.now()}`, createdById: owner.user.id },
      select: { id: true },
    });
    householdId = household.id;
    createdHouseholdIds.push(householdId);
    await prisma.membership.createMany({
      data: [
        { userId: owner.user.id, householdId, role: 'OWNER' },
        { userId: wyrzucany.user.id, householdId, role: 'MEMBER' },
        { userId: wychodzacy.user.id, householdId, role: 'MEMBER' },
      ],
    });
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await prisma.cookidooIntegration.deleteMany({
      where: { householdId: { in: createdHouseholdIds } },
    });
    await prisma.household.deleteMany({
      where: { id: { in: createdHouseholdIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
    for (const key of Object.keys(process.env)) {
      if (!(key in env)) delete process.env[key];
    }
    Object.assign(process.env, env);
  });

  it('właściciel usuwa domownika W TRAKCIE zapisu jego hasła: hasło nie zostaje', async () => {
    expect(await credentials()).toBe(0);
    const latch = duringCredentialWrite(() =>
      households.removeMember(owner.user.id, householdId, wyrzucany.user.id),
    );

    const res = await connect(wyrzucany);
    const removal = await latch.done();

    expect(latch.fired()).toBe(true);
    expect(removal).not.toBeInstanceOf(Error);
    // Zapis zdążył przed usunięciem (201) — i tak sprzątanie go zabrało.
    expect(res.status).toBe(201);
    expect(
      await prisma.membership.count({
        where: { userId: wyrzucany.user.id, householdId },
      }),
    ).toBe(0);
    expect(await credentials()).toBe(0);
  });

  it('domownik wychodzi z domu W TRAKCIE zapisu swojego hasła: hasło nie zostaje', async () => {
    expect(await credentials()).toBe(0);
    const latch = duringCredentialWrite(() =>
      households.leave(wychodzacy.user.id, householdId),
    );

    const res = await connect(wychodzacy);
    const removal = await latch.done();

    expect(latch.fired()).toBe(true);
    expect(removal).not.toBeInstanceOf(Error);
    expect(res.status).toBe(201);
    expect(
      await prisma.membership.count({
        where: { userId: wychodzacy.user.id, householdId },
      }),
    ).toBe(0);
    expect(await credentials()).toBe(0);
  });
});
