import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { AddressInfo } from 'net';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { VALID_PAYLOADS } from '../src/common/ws-payload-fixtures.spec-helper';

/**
 * Jeden przebieg po WSZYSTKICH zdarzeniach WS niosących `householdId`:
 * użytkownik domu A, z własnym poprawnym tokenem, podaje `householdId` domu B.
 * Każde takie wywołanie ma się odbić, a dom B ma wyjść z przebiegu bez
 * jednej zmienionej litery.
 *
 * AUDYT 12.09.2026 (P1.10). Bramki członkostwa są na miejscu i sprawdziłem je
 * po kolei — ale sprawdzone były dotąd WYŁĄCZNIE na atrapach, per serwis.
 * Nowy handler wchodzi do repo bez żadnego testu, który zapytałby „a co, jak
 * ktoś poda cudze id". Ta suita zadaje to pytanie automatycznie: lista
 * zdarzeń bierze się z `VALID_PAYLOADS`, więc dopisanie handlera z
 * `householdId` DOKŁADA tu przypadek, nie omija go.
 *
 * Odmowa może przyjść na dwa sposoby i oba są w porządku: `ensureMembership`
 * daje `NOT_HOUSEHOLD_MEMBER`/`FORBIDDEN`, a bramki odczytu celowo udają
 * nieistnienie (`NOT_FOUND`) — cudzy zasób ma nie różnić się od nieistniejącego.
 * Czego być NIE MOŻE, to `ok: true`.
 */
type WsEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: string; status?: number };

type Session = {
  accessToken: string;
  refreshToken: string;
  user: { id: string; displayName: string };
  household: { id: string; name: string } | null;
};

/** Kody, którymi wolno odmówić. Wszystko poza tym to znalezisko. */
const DOZWOLONE_ODMOWY = new Set([
  'NOT_HOUSEHOLD_MEMBER',
  'FORBIDDEN',
  'NOT_FOUND',
  'HOUSEHOLD_NOT_FOUND',
  'MEMBER_NOT_FOUND',
  'OWNER_REQUIRED',
  'VALIDATION_ERROR',
  'RECIPE_NOT_FOUND',
  'UNAUTHORIZED',
]);

/** Podmienia KAŻDE `householdId` w kopercie, na dowolnej głębokości. */
const podmienDom = (value: unknown, householdId: string): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => podmienDom(entry, householdId));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        key === 'householdId' ? householdId : podmienDom(entry, householdId),
      ]),
    );
  }
  return value;
};

const niesieDom = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(niesieDom);
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, entry]) => key === 'householdId' || niesieDom(entry),
    );
  }
  return false;
};

/**
 * Jedyne zdarzenie, które ODPOWIADA na cudzy `householdId` — i wolno mu.
 *
 * `weeklyPlans:getSavedPlan` to zaślepka po wycofanej puli tygodniowej
 * (`SharedMealPlan`). Nie dotyka bazy: oddaje stałe `{ weekStart, items: [] }`,
 * gdzie `weekStart` jest echem tego, co przyszło od klienta. Istnieje tylko po
 * to, żeby aplikacja ze sklepu nie czekała 3 × 6 s na ACK przy każdej zmianie
 * tygodnia. Dokładanie mu `ensureMembership` kosztowałoby zapytanie do bazy
 * przy każdym przewinięciu kalendarza na starym telefonie i nie zasłoniłoby
 * niczego, bo nie ma czego zasłaniać.
 *
 * Wyjątek pilnuje sam siebie: osobny test niżej sprawdza, że odpowiedź nadal
 * jest pusta. W chwili, w której ktoś każe tej zaślepce czytać bazę, ten test
 * zapali się na czerwono.
 */
const ZASLEPKA_BEZ_DANYCH = 'weeklyPlans:getSavedPlan';

const ZDARZENIA_Z_DOMEM = Object.entries(VALID_PAYLOADS).filter(
  ([event, payload]) => niesieDom(payload) && event !== ZASLEPKA_BEZ_DANYCH,
);

describe('Cudzy householdId E2E', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  let socket: Socket;
  /** Sesja napastnika: prawdziwe konto, prawdziwy token, własny dom. */
  let atakujacy: Session;
  /** Dom ofiary — z nazwą, przepisem i pozycją planu, żeby było co popsuć. */
  let domB: string;
  /** Własny dom napastnika: dowód, że bramka nie odcina go od siebie. */
  let domA: string;
  let ofiara: Session;

  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];
  const sockets: Socket[] = [];
  const originalMode = process.env.WS_AUTH_MODE;

  const devLogin = async (label: string): Promise<Session> => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `${label} ${stamp}`,
        email: `${label.toLowerCase()}-${stamp}@idor.local`,
      })
      .expect(201);
    const created = res.body as Session;
    createdUserIds.push(created.user.id);
    if (created.household) createdHouseholdIds.push(created.household.id);
    return created;
  };

  const createHousehold = async (ownerId: string, name: string) => {
    const household = await prisma.household.create({
      data: { name: `${name} ${Date.now()}`, createdById: ownerId },
      select: { id: true },
    });
    createdHouseholdIds.push(household.id);
    await prisma.membership.create({
      data: { userId: ownerId, householdId: household.id, role: 'OWNER' },
    });
    return household.id;
  };

  const ack = <T>(
    client: Socket,
    event: string,
    payload: unknown,
  ): Promise<WsEnvelope<T>> =>
    new Promise((resolve, reject) => {
      client
        .timeout(7000)
        .emit(event, payload, (err: Error | null, response: WsEnvelope<T>) => {
          if (err) reject(err);
          else resolve(response);
        });
    });

  /** Odcisk domu B: wszystko, co ten przebieg mógłby popsuć. */
  const odciskDomu = async () => {
    const household = await prisma.household.findUnique({
      where: { id: domB },
      select: { name: true, enabledMealTypes: true, mealSlotTimes: true },
    });
    const [members, recipes, planItems, invitations, favorites] =
      await Promise.all([
        prisma.membership.findMany({
          where: { householdId: domB },
          orderBy: { userId: 'asc' },
          select: { userId: true, role: true },
        }),
        prisma.recipe.count({ where: { householdId: domB } }),
        prisma.planItem.count({
          where: { weeklyPlan: { householdId: domB } },
        }),
        prisma.invitation.count({ where: { householdId: domB } }),
        prisma.recipeFavorite.count({ where: { householdId: domB } }),
      ]);
    return {
      household,
      members,
      recipes,
      planItems,
      invitations,
      favorites,
    };
  };

  beforeAll(async () => {
    process.env.WS_AUTH_MODE = 'strict';
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      rawBody: true,
    });
    configureApp(app);
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    prisma = app.get(PrismaService);

    atakujacy = await devLogin('Napastnik');
    ofiara = await devLogin('Ofiara');
    // `POST /auth/dev` zakłada konto, ale NIE zakłada gospodarstwa — dom
    // powstaje dopiero przez `households:create` albo zaproszenie. Oba domy
    // stawiamy więc wprost, żeby test opisywał autoryzację, a nie onboarding.
    domA = await createHousehold(atakujacy.user.id, 'Dom napastnika');
    domB = await createHousehold(ofiara.user.id, 'Dom ofiary');

    // Dom B dostaje treść: własny przepis i pozycję w planie.
    const recipe = await prisma.recipe.create({
      data: {
        householdId: domB,
        authorId: ofiara.user.id,
        title: `Sekretny przepis ${Date.now()}`,
        mealType: 'DINNER',
        difficulty: 'EASY',
        prepTimeMinutes: 20,
        servings: 2,
        isCatalog: false,
      },
      select: { id: true },
    });
    const plan = await prisma.weeklyPlan.create({
      data: { householdId: domB, weekStart: new Date('2026-10-05T00:00:00Z') },
      select: { id: true },
    });
    await prisma.planItem.create({
      data: {
        weeklyPlanId: plan.id,
        recipeId: recipe.id,
        dayOfWeek: 'MON',
        mealType: 'DINNER',
        plannedServings: 2,
      },
    });

    socket = io(baseUrl, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { token: atakujacy.accessToken },
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', (err: Error) => reject(err));
    });
  });

  afterAll(async () => {
    for (const client of sockets) client.close();
    await prisma.planItem.deleteMany({
      where: { weeklyPlan: { householdId: { in: createdHouseholdIds } } },
    });
    await prisma.weeklyPlan.deleteMany({
      where: { householdId: { in: createdHouseholdIds } },
    });
    await prisma.recipe.deleteMany({
      where: { householdId: { in: createdHouseholdIds } },
    });
    await prisma.invitation.deleteMany({
      where: { householdId: { in: createdHouseholdIds } },
    });
    await prisma.household.deleteMany({
      where: { id: { in: createdHouseholdIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
    if (originalMode === undefined) delete process.env.WS_AUTH_MODE;
    else process.env.WS_AUTH_MODE = originalMode;
  });

  it('lista zdarzeń nie jest pusta — inaczej ta suita niczego nie sprawdza', () => {
    // Zabezpieczenie przed cichym rozjazdem: gdyby ktoś przebudował kształt
    // koperty i `householdId` przestał się tu znajdować, cała pętla niżej
    // przeszłaby na zielono, nie robiąc nic.
    expect(ZDARZENIA_Z_DOMEM.length).toBeGreaterThanOrEqual(20);
  });

  it.each(ZDARZENIA_Z_DOMEM)(
    '%s z cudzym householdId → odmowa',
    async (event, payload) => {
      const response = await ack(socket, event, podmienDom(payload, domB));

      expect(response.ok).toBe(false);
      if (response.ok) return;
      expect([event, response.code]).toEqual([
        event,
        expect.stringMatching(
          new RegExp(`^(${[...DOZWOLONE_ODMOWY].join('|')})$`),
        ),
      ]);
    },
  );

  it('po całym przebiegu dom B jest bit w bit taki sam', async () => {
    const przed = await odciskDomu();

    for (const [event, payload] of ZDARZENIA_Z_DOMEM) {
      await ack(socket, event, podmienDom(payload, domB));
    }

    expect(await odciskDomu()).toEqual(przed);
  });

  it('applyWeekPlan BEZ dryRun też nie tyka cudzego planu', async () => {
    // Najgroźniejsze zdarzenie w całym module: zapis stanu docelowego, czyli
    // „czego nie ma na liście, tego nie ma w planie". Fixture ma `dryRun:
    // true`, więc bez tego przypadku najostrzejsza ścieżka byłaby nietknięta.
    const przed = await odciskDomu();

    const response = await ack(socket, 'weeklyPlans:applyWeekPlan', {
      householdId: domB,
      weekStart: '2026-10-05',
      data: { slots: [], dryRun: false },
    });

    expect(response.ok).toBe(false);
    expect(await odciskDomu()).toEqual(przed);
    expect(przed.planItems).toBeGreaterThan(0);
  });

  it(`${ZASLEPKA_BEZ_DANYCH} odpowiada, ale nie ma czym — pusta pula`, async () => {
    const response = await ack<{ weekStart: string; items: unknown[] }>(
      socket,
      ZASLEPKA_BEZ_DANYCH,
      { householdId: domB, weekStart: '2026-10-05' },
    );

    // Wyjątek od reguły „cudzy dom = odmowa" jest dopuszczalny WYŁĄCZNIE
    // dopóki odpowiedź nie niesie ani grama cudzych danych. Dom B ma w tym
    // tygodniu pozycję planu — gdyby handler czytał bazę, byłaby tutaj.
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data).toEqual({ weekStart: '2026-10-05', items: [] });
  });

  it('households:findById z cudzym id nie oddaje nazwy domu', async () => {
    // `findById` bierze `id`, nie `householdId`, więc pętla wyżej go nie łapie.
    const response = await ack<{ name?: string }>(
      socket,
      'households:findById',
      { id: domB },
    );

    expect(response.ok).toBe(false);
  });

  it('napastnik dalej rządzi we WŁASNYM domu — bramka nie jest za szeroka', async () => {
    const response = await ack(socket, 'households:listMembers', {
      householdId: domA,
    });

    expect(response.ok).toBe(true);
  });
});
