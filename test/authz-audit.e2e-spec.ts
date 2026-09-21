import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { AddressInfo } from 'net';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * AUDYT AUTORYZACJI 21.09.2026 — po jednym dowodzie na żywej bazie dla każdego
 * znaleziska, plus ścieżki legalne, żeby było widać, że bramki nie są za
 * szerokie.
 *
 * `cross-household-idor.e2e-spec.ts` podmienia `householdId` i sprawdza samo
 * „odmówiono". Tego, co znalazł ten audyt, tamta suita nie widzi, bo tu nie
 * chodzi o cudzy `householdId`, tylko o:
 *  - KOD odmowy (403 dla istniejącego, 404 dla nieistniejącego = wyrocznia),
 *  - byłego domownika, który wraca cudzym linkiem albo czyta stare rozmowy,
 *  - żądania równoległe, które mijały kontrolę liczoną przed transakcją.
 */
type WsEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: string; status?: number };

type Session = {
  accessToken: string;
  user: { id: string; displayName: string };
  household: { id: string } | null;
};

const WEEK = '2026-10-05';
const NIEISTNIEJACE = '9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';

describe('Audyt autoryzacji 21.09.2026 E2E', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let baseUrl: string;

  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];
  const sockets: Socket[] = [];
  const env = { ...process.env };

  const devLogin = async (label: string): Promise<Session> => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `${label} ${stamp}`,
        email: `${label.toLowerCase()}-${stamp}@authz.local`,
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

  const addMember = (
    householdId: string,
    userId: string,
    role: 'OWNER' | 'MEMBER' = 'MEMBER',
  ) => prisma.membership.create({ data: { userId, householdId, role } });

  const connect = async (session: Session): Promise<Socket> => {
    const socket = io(baseUrl, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { token: session.accessToken },
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', (err: Error) => reject(err));
    });
    return socket;
  };

  const ack = <T>(
    client: Socket,
    event: string,
    payload: unknown,
  ): Promise<WsEnvelope<T>> =>
    new Promise((resolve, reject) => {
      client
        .timeout(10000)
        .emit(event, payload, (err: Error | null, response: WsEnvelope<T>) => {
          if (err) reject(err);
          else resolve(response);
        });
    });

  const kod = <T>(response: WsEnvelope<T>): string =>
    response.ok ? 'OK' : response.code;

  const createRecipe = async (householdId: string, authorId: string) => {
    const recipe = await prisma.recipe.create({
      data: {
        householdId,
        authorId,
        title: `Przepis audytu ${Date.now()}-${Math.random()}`,
        mealType: 'DINNER',
        difficulty: 'EASY',
        prepTimeMinutes: 20,
        servings: 2,
        isCatalog: false,
      },
      select: { id: true },
    });
    return recipe.id;
  };

  beforeAll(async () => {
    process.env.WS_AUTH_MODE = 'strict';
    process.env.AI_ENABLED = 'true';
    process.env.AI_PROVIDER = 'stub';
    process.env.AI_STUB_DELAY_MS = '0';
    process.env.AI_TIER_OVERRIDE = 'PRO';
    process.env.AI_CONSENT_REQUIRED = 'false';
    delete process.env.AI_ALLOWED_USERS;

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
  });

  afterAll(async () => {
    for (const client of sockets) client.close();
    await prisma.agentConversation.deleteMany({
      where: { userId: { in: createdUserIds } },
    });
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
    for (const key of Object.keys(process.env)) {
      if (!(key in env)) delete process.env[key];
    }
    Object.assign(process.env, env);
  });

  describe('wyrocznia istnienia: cudze i nieistniejące wygląda tak samo', () => {
    let obcy: Socket;
    let obcySesja: Session;
    let domObcego: string;
    let domOfiary: string;
    let przepisOfiary: string;
    let wlasnyPrzepis: string;

    beforeAll(async () => {
      obcySesja = await devLogin('Ciekawski');
      const ofiara = await devLogin('Ofiara');
      domObcego = await createHousehold(obcySesja.user.id, 'Dom ciekawskiego');
      domOfiary = await createHousehold(ofiara.user.id, 'Dom ofiary');
      przepisOfiary = await createRecipe(domOfiary, ofiara.user.id);
      wlasnyPrzepis = await createRecipe(domObcego, obcySesja.user.id);
      obcy = await connect(obcySesja);
    });

    it.each([
      ['households:findById', (id: string) => ({ id })],
      [
        'households:updateName',
        (id: string) => ({ householdId: id, data: { name: 'Przejęty' } }),
      ],
      ['households:listMembers', (id: string) => ({ householdId: id })],
      [
        'households:removeMember',
        (id: string) => ({ householdId: id, memberUserId: NIEISTNIEJACE }),
      ],
      ['households:leave', (id: string) => ({ householdId: id })],
    ])(
      '%s: dom istniejący i nieistniejący dają ten sam kod',
      async (event, payload) => {
        const istniejacy = await ack(obcy, event, payload(domOfiary));
        const zPowietrza = await ack(obcy, event, payload(NIEISTNIEJACE));
        expect(kod(istniejacy)).toBe('NOT_HOUSEHOLD_MEMBER');
        expect(kod(zPowietrza)).toBe(kod(istniejacy));
      },
    );

    it('recipes:findById z cudzym householdId nie zdradza, czy przepis istnieje', async () => {
      const istniejacy = await ack(obcy, 'recipes:findById', {
        id: przepisOfiary,
        householdId: domOfiary,
      });
      const zPowietrza = await ack(obcy, 'recipes:findById', {
        id: NIEISTNIEJACE,
        householdId: domOfiary,
      });
      expect(kod(istniejacy)).toBe('NOT_HOUSEHOLD_MEMBER');
      expect(kod(zPowietrza)).toBe('NOT_HOUSEHOLD_MEMBER');
    });

    it('recipes:setFavorite z cudzym householdId — to samo', async () => {
      const proba = (recipeId: string) =>
        ack(obcy, 'recipes:setFavorite', {
          data: { recipeId, householdId: domOfiary, isFavorite: true },
        });
      expect(kod(await proba(przepisOfiary))).toBe('NOT_HOUSEHOLD_MEMBER');
      expect(kod(await proba(NIEISTNIEJACE))).toBe('NOT_HOUSEHOLD_MEMBER');
      expect(
        await prisma.recipeFavorite.count({
          where: { recipeId: przepisOfiary },
        }),
      ).toBe(0);
    });

    it('cudzy przepis z WŁASNYM householdId: 404 jak nieistniejący, bez treści', async () => {
      const cudzy = await ack(obcy, 'recipes:findById', {
        id: przepisOfiary,
        householdId: domObcego,
      });
      const zPowietrza = await ack(obcy, 'recipes:findById', {
        id: NIEISTNIEJACE,
        householdId: domObcego,
      });
      expect(kod(cudzy)).toBe('RECIPE_NOT_FOUND');
      expect(kod(zPowietrza)).toBe('RECIPE_NOT_FOUND');
      expect(JSON.stringify(cudzy)).not.toContain('Przepis audytu');
    });

    it('legalnie: własny dom i własny przepis działają jak dotąd', async () => {
      const dom = await ack<{ id: string }>(obcy, 'households:findById', {
        id: domObcego,
      });
      expect(dom.ok && dom.data.id).toBe(domObcego);
      const przepis = await ack<{ id: string }>(obcy, 'recipes:findById', {
        id: wlasnyPrzepis,
        householdId: domObcego,
      });
      expect(przepis.ok && przepis.data.id).toBe(wlasnyPrzepis);
      const ulubiony = await ack(obcy, 'recipes:setFavorite', {
        data: {
          recipeId: wlasnyPrzepis,
          householdId: domObcego,
          isFavorite: true,
        },
      });
      expect(ulubiony.ok).toBe(true);
    });
  });

  describe('wyrzucony domownik nie wraca innym otwartym linkiem', () => {
    it('wyrzucenie gasi WSZYSTKIE otwarte linki domu; po nim nowy link działa', async () => {
      const wlasciciel = await devLogin('Gospodarz');
      const wyrzucany = await devLogin('Wyrzucany');
      const gosc = await devLogin('Gosc');
      const dom = await createHousehold(wlasciciel.user.id, 'Dom z linkami');
      const sWlasciciel = await connect(wlasciciel);
      const sWyrzucany = await connect(wyrzucany);
      const sGosc = await connect(gosc);

      const nowyLink = async () => {
        const res = await ack<{ token: string }>(
          sWlasciciel,
          'households:createInvitation',
          { householdId: dom, data: {} },
        );
        if (!res.ok) throw new Error(res.code);
        return res.data.token;
      };
      // Dwa linki na rodzinnym czacie: jednym wchodzi, drugi zostaje otwarty.
      const link1 = await nowyLink();
      const link2 = await nowyLink();
      const wejscie = await ack(sWyrzucany, 'households:acceptInvitation', {
        data: { token: link1 },
      });
      expect(wejscie.ok).toBe(true);

      // MEMBER nie wyrzuca nikogo — operacja tylko dla OWNER-a.
      const samowolka = await ack(sWyrzucany, 'households:removeMember', {
        householdId: dom,
        memberUserId: wlasciciel.user.id,
      });
      expect(kod(samowolka)).toBe('OWNER_REQUIRED');

      const wyrzucenie = await ack(sWlasciciel, 'households:removeMember', {
        householdId: dom,
        memberUserId: wyrzucany.user.id,
      });
      expect(wyrzucenie.ok).toBe(true);

      // Sedno: drugi, wciąż „ważny" link nie wpuszcza z powrotem.
      const powrot = await ack(sWyrzucany, 'households:acceptInvitation', {
        data: { token: link2 },
      });
      expect(kod(powrot)).toBe('INVITATION_EXPIRED');
      expect(
        await prisma.membership.count({
          where: { householdId: dom, userId: wyrzucany.user.id },
        }),
      ).toBe(0);

      // Stary identyfikator domu jest dla wyrzuconego martwy — odczyt i zapis.
      const odczyt = await ack(sWyrzucany, 'weeklyPlans:getByWeek', {
        householdId: dom,
        weekStart: WEEK,
      });
      expect(kod(odczyt)).toBe('NOT_HOUSEHOLD_MEMBER');
      const zapis = await ack(sWyrzucany, 'households:updateMealTimes', {
        householdId: dom,
        data: { mealSlotTimes: { DINNER: '18:00' } },
      });
      expect(zapis.ok).toBe(false);

      // Legalna ścieżka: właściciel wystawia NOWY link i gość nim wchodzi.
      const link3 = await nowyLink();
      const gościna = await ack(sGosc, 'households:acceptInvitation', {
        data: { token: link3 },
      });
      expect(gościna.ok).toBe(true);
    });

    it('samodzielne wyjście NIE gasi cudzych linków — kto wyszedł sam, może wrócić', async () => {
      const wlasciciel = await devLogin('Gospodarz2');
      const bywalec = await devLogin('Bywalec');
      const dom = await createHousehold(wlasciciel.user.id, 'Dom otwarty');
      await addMember(dom, bywalec.user.id);
      const sWlasciciel = await connect(wlasciciel);
      const sBywalec = await connect(bywalec);
      const link = await ack<{ token: string }>(
        sWlasciciel,
        'households:createInvitation',
        { householdId: dom, data: {} },
      );
      if (!link.ok) throw new Error(link.code);

      expect(
        (await ack(sBywalec, 'households:leave', { householdId: dom })).ok,
      ).toBe(true);
      const powrot = await ack(sBywalec, 'households:acceptInvitation', {
        data: { token: link.data.token },
      });
      expect(powrot.ok).toBe(true);
    });
  });

  describe('operacje równoległe nie omijają kontroli', () => {
    it('dwóch właścicieli degraduje się nawzajem w tej samej chwili — dom nie zostaje bez właściciela', async () => {
      for (let runda = 0; runda < 5; runda += 1) {
        const a = await devLogin('WlascicielA');
        const b = await devLogin('WlascicielB');
        const dom = await createHousehold(a.user.id, 'Dom dwóch właścicieli');
        await addMember(dom, b.user.id, 'OWNER');
        const [sA, sB] = await Promise.all([connect(a), connect(b)]);

        const wyniki = await Promise.all([
          ack(sA, 'households:updateMemberRole', {
            householdId: dom,
            memberUserId: b.user.id,
            data: { role: 'MEMBER' },
          }),
          ack(sB, 'households:updateMemberRole', {
            householdId: dom,
            memberUserId: a.user.id,
            data: { role: 'MEMBER' },
          }),
        ]);

        const owners = await prisma.membership.count({
          where: { householdId: dom, role: 'OWNER' },
        });
        expect(owners).toBe(1);
        // Dokładnie jedno żądanie wygrało; przegrany dostał odmowę, nie 500.
        expect(wyniki.filter((w) => w.ok)).toHaveLength(1);
        const przegrany = wyniki.find((w) => !w.ok);
        expect(['OWNER_REQUIRED', 'LAST_OWNER']).toContain(
          przegrany ? kod(przegrany) : '',
        );
      }
    });

    it('dwóch właścicieli wyrzuca się nawzajem — zostaje jeden, z rolą OWNER', async () => {
      for (let runda = 0; runda < 5; runda += 1) {
        const a = await devLogin('WyrzucaA');
        const b = await devLogin('WyrzucaB');
        const dom = await createHousehold(a.user.id, 'Dom pojedynku');
        await addMember(dom, b.user.id, 'OWNER');
        const [sA, sB] = await Promise.all([connect(a), connect(b)]);

        const wyniki = await Promise.all([
          ack(sA, 'households:removeMember', {
            householdId: dom,
            memberUserId: b.user.id,
          }),
          ack(sB, 'households:removeMember', {
            householdId: dom,
            memberUserId: a.user.id,
          }),
        ]);

        const zostali = await prisma.membership.findMany({
          where: { householdId: dom },
          select: { role: true },
        });
        expect(zostali).toEqual([{ role: 'OWNER' }]);
        expect(wyniki.filter((w) => w.ok)).toHaveLength(1);
      }
    });

    it('zapis planu ścigający się z wyrzuceniem: były domownik nie zostaje w planie jako uczestnik', async () => {
      for (let runda = 0; runda < 5; runda += 1) {
        const wlasciciel = await devLogin('Planista');
        const wyrzucany = await devLogin('Znikajacy');
        const trzeci = await devLogin('Trzeci');
        const dom = await createHousehold(wlasciciel.user.id, 'Dom z planem');
        await addMember(dom, wyrzucany.user.id);
        await addMember(dom, trzeci.user.id);
        const przepis = await createRecipe(dom, wlasciciel.user.id);
        // Tydzień musi istnieć, żeby usunięcie i zapis spotkały się na zamku.
        await prisma.weeklyPlan.create({
          data: { householdId: dom, weekStart: new Date(`${futureMonday()}`) },
        });
        const [sWlasciciel, sWyrzucany] = await Promise.all([
          connect(wlasciciel),
          connect(wyrzucany),
        ]);

        await Promise.all([
          ack(sWlasciciel, 'households:removeMember', {
            householdId: dom,
            memberUserId: wyrzucany.user.id,
          }),
          ack(sWyrzucany, 'weeklyPlans:upsertWeekSlot', {
            householdId: dom,
            weekStart: futureMonday().slice(0, 10),
            data: {
              dayOfWeek: 'MON',
              mealType: 'DINNER',
              recipeId: przepis,
              participantIds: [wyrzucany.user.id],
              plannedServings: 1,
            },
          }),
        ]);

        // Kolejność dowolna, wynik jeden: po obu operacjach w planie domu nie
        // ma wiersza uczestnika dla osoby, której w domu już nie ma.
        const duchy = await prisma.planItemParticipant.count({
          where: {
            userId: wyrzucany.user.id,
            planItem: { weeklyPlan: { householdId: dom } },
          },
        });
        expect(duchy).toBe(0);
      }
    });

    it('legalnie: domownik dalej zapisuje plan, także z uczestnikami', async () => {
      const wlasciciel = await devLogin('Kucharz');
      const domownik = await devLogin('Domownik');
      const dom = await createHousehold(wlasciciel.user.id, 'Dom zwykły');
      await addMember(dom, domownik.user.id);
      const przepis = await createRecipe(dom, wlasciciel.user.id);
      const sDomownik = await connect(domownik);

      const zapis = await ack(sDomownik, 'weeklyPlans:upsertWeekSlot', {
        householdId: dom,
        weekStart: WEEK,
        data: {
          dayOfWeek: 'TUE',
          mealType: 'DINNER',
          recipeId: przepis,
          participantIds: [domownik.user.id],
          plannedServings: 1,
        },
      });
      expect(zapis.ok).toBe(true);
      const wsad = await ack<{ applied: boolean }>(
        sDomownik,
        'weeklyPlans:applyWeekPlan',
        {
          householdId: dom,
          weekStart: WEEK,
          data: {
            slots: [
              {
                dayOfWeek: 'WED',
                mealType: 'DINNER',
                recipeId: przepis,
                participantIds: [wlasciciel.user.id],
                plannedServings: 1,
              },
            ],
          },
        },
      );
      expect(wsad.ok && wsad.data.applied).toBe(true);
      expect(
        (
          await ack(sDomownik, 'weeklyPlans:removeWeekSlot', {
            householdId: dom,
            weekStart: WEEK,
            data: { dayOfWeek: 'WED', mealType: 'DINNER' },
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await ack(sDomownik, 'weeklyPlans:clearWeekPlan', {
            householdId: dom,
            weekStart: WEEK,
          })
        ).ok,
      ).toBe(true);

      // Manipulacja w payloadzie: obcy jako uczestnik nie przechodzi.
      const obcy = await devLogin('Niedomownik');
      const podrzucony = await ack(sDomownik, 'weeklyPlans:upsertWeekSlot', {
        householdId: dom,
        weekStart: WEEK,
        userId: wlasciciel.user.id,
        data: {
          dayOfWeek: 'THU',
          mealType: 'DINNER',
          recipeId: przepis,
          participantIds: [obcy.user.id],
          plannedServings: 1,
        },
      });
      expect(kod(podrzucony)).toBe('PLAN_PARTICIPANT_NOT_IN_HOUSEHOLD');
    });
  });

  describe('trasy /ops: brak OPS_TOKEN znaczy ZAMKNIĘTE, nie otwarte', () => {
    const TRASY = ['/ops/metrics', '/ops/billing/subscriptions'];
    const przy = async (
      zmienne: { NODE_ENV: string; OPS_TOKEN?: string },
      proba: () => Promise<void>,
    ) => {
      const przed = {
        NODE_ENV: process.env.NODE_ENV,
        OPS_TOKEN: process.env.OPS_TOKEN,
      };
      process.env.NODE_ENV = zmienne.NODE_ENV;
      if (zmienne.OPS_TOKEN === undefined) delete process.env.OPS_TOKEN;
      else process.env.OPS_TOKEN = zmienne.OPS_TOKEN;
      try {
        await proba();
      } finally {
        for (const [key, value] of Object.entries(przed)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    };

    it.each(['staging', 'development', 'production'])(
      'NODE_ENV=%s bez OPS_TOKEN: 403 z nagłówkiem i bez',
      async (nodeEnv) => {
        await przy({ NODE_ENV: nodeEnv }, async () => {
          for (const trasa of TRASY) {
            await request(app.getHttpServer()).get(trasa).expect(403);
            await request(app.getHttpServer())
              .get(trasa)
              .set('x-ops-token', 'cokolwiek')
              .expect(403);
          }
        });
      },
    );

    it('staging z OPS_TOKEN: błędny token 403, poprawny 200, a odmowa nie zdradza tokenu', async () => {
      const token = 'staging-ops-token-0123456789abcdef';
      await przy({ NODE_ENV: 'staging', OPS_TOKEN: token }, async () => {
        const zly = await request(app.getHttpServer())
          .get('/ops/metrics')
          .set('x-ops-token', `${token}x`)
          .expect(403);
        expect(JSON.stringify(zly.body)).not.toContain(token);
        await request(app.getHttpServer())
          .get('/ops/metrics')
          .set('x-ops-token', token)
          .expect(200);
      });
    });

    it('sonda /ops/health zostaje publiczna także bez OPS_TOKEN', async () => {
      await przy({ NODE_ENV: 'staging' }, async () => {
        await request(app.getHttpServer()).get('/ops/health').expect(200);
      });
    });
  });

  describe('asystent: były domownik nie widzi rozmów o cudzym już domu', () => {
    const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

    it('lista rozmów znika razem z członkostwem; własne rozmowy z nowego domu zostają', async () => {
      const wlasciciel = await devLogin('GospodarzAI');
      const byly = await devLogin('BylyAI');
      const staryDom = await createHousehold(wlasciciel.user.id, 'Stary dom');
      await addMember(staryDom, byly.user.id);

      const rozmowa = await request(app.getHttpServer())
        .post('/agent/conversations')
        .set(auth(byly.accessToken))
        .send({ householdId: staryDom })
        .expect(201);
      const rozmowaId = (rozmowa.body as { id: string }).id;
      // Treść, której były domownik nie powinien już oglądać w podglądzie.
      await prisma.agentMessage.create({
        data: {
          conversationId: rozmowaId,
          role: 'ASSISTANT',
          text: 'Plan domu: w piątek goście, na liście zakupów szampan.',
        },
      });

      const lista = async () =>
        (
          await request(app.getHttpServer())
            .get('/agent/conversations')
            .set(auth(byly.accessToken))
            .expect(200)
        ).body as { id: string; preview: string | null }[];

      // Legalnie: dopóki należy do domu, widzi rozmowę z podglądem.
      const przed = await lista();
      expect(przed.find((r) => r.id === rozmowaId)?.preview).toContain(
        'szampan',
      );

      const sWlasciciel = await connect(wlasciciel);
      expect(
        (
          await ack(sWlasciciel, 'households:removeMember', {
            householdId: staryDom,
            memberUserId: byly.user.id,
          })
        ).ok,
      ).toBe(true);

      const po = await lista();
      expect(po.find((r) => r.id === rozmowaId)).toBeUndefined();
      expect(JSON.stringify(po)).not.toContain('szampan');
      // Otwarcie po starym id — 404, jak dotąd.
      await request(app.getHttpServer())
        .get(`/agent/conversations/${rozmowaId}`)
        .set(auth(byly.accessToken))
        .expect(404);

      // Nowy, własny dom: rozmowy z niego są na liście.
      const nowyDom = await createHousehold(byly.user.id, 'Nowy dom');
      const nowa = await request(app.getHttpServer())
        .post('/agent/conversations')
        .set(auth(byly.accessToken))
        .send({ householdId: nowyDom })
        .expect(201);
      const poPrzeprowadzce = await lista();
      expect(poPrzeprowadzce.map((r) => r.id)).toEqual([
        (nowa.body as { id: string }).id,
      ]);
    });
  });
});

/** Poniedziełek za ~4 tygodnie, 00:00Z — `onMemberLeft` sprząta od bieżącego tygodnia w przód. */
function futureMonday(): string {
  const now = new Date();
  const day = now.getUTCDay();
  const monday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  monday.setUTCDate(monday.getUTCDate() - ((day + 6) % 7) + 28);
  return monday.toISOString();
}
