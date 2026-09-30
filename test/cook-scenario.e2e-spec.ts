import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { AddressInfo } from 'net';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  resolveGoldenContent,
  type GoldenScenarioFile,
} from '../src/recipes/cook-scenario/cook-scenario.golden';
import { publishCookScenario } from '../src/recipes/cook-scenario/cook-scenario.publish';
import type { CookScenarioResponse } from '../src/recipes/cook-scenario/cook-scenario.types';
import { AppException } from '../src/common/app-exception';

/**
 * Scenariusze trybu Gotuj (Etap E2) na żywej bazie:
 * - publikacja wzorca kotleta (nazwy → id tej bazy, walidatory, wersje,
 *   jeden PUBLISHED, `Recipe.cookScenarioVersion`) i jej idempotencja;
 * - publikacja przesuwa log katalogu — telefon dowie się o trybie Gotuj deltą;
 * - `recipes:cookScenario`: bramka członkostwa przed odczytem, przepis domu
 *   niewidoczny dla obcych (404), przepis bez scenariusza i scenariusz
 *   nieaktualny (zmieniony przepis) = `scenario: null`;
 * - zła treść = VALIDATION_ERROR i nic się nie zapisuje.
 *
 * Wzorzec publikujemy na przepisie KATALOGU (tak jak zrobi to loader), a
 * `afterAll` przywraca jego stan sprzed testu.
 */
type WsEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; message?: string; code: string };

type Session = {
  accessToken: string;
  user: { id: string };
  household: { id: string } | null;
};

const GOLDEN = JSON.parse(
  readFileSync(
    join(__dirname, '..', 'prisma', 'catalog', 'cook-scenarios-pl-v1.json'),
    'utf8',
  ),
) as GoldenScenarioFile;
const KOTLET = GOLDEN.scenarios[0];

describe('Scenariusze Gotuj E2E', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let baseUrl: string;

  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];
  const createdRecipeIds: string[] = [];
  const sockets: Socket[] = [];
  const originalMode = process.env.WS_AUTH_MODE;

  let householdA: string;
  let householdB: string;
  let socketA: Socket;
  let socketB: Socket;
  let privateRecipeId: string;
  let kotletVersionBefore: number | null = null;
  let kotletScenarioIdsBefore: string[] = [];

  const devLogin = async (label: string): Promise<Session> => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `${label} ${stamp}`,
        email: `${label.toLowerCase()}-${stamp}@cook.local`,
      })
      .expect(201);
    const session = res.body as Session;
    createdUserIds.push(session.user.id);
    if (session.household) createdHouseholdIds.push(session.household.id);
    return session;
  };

  const connect = async (token: string): Promise<Socket> => {
    const client = io(baseUrl, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { token },
    });
    sockets.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('connect_error', (err: Error) => reject(err));
    });
    return client;
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

  const okData = <T>(envelope: WsEnvelope<T>): T => {
    if (!envelope.ok)
      throw new Error(`oczekiwano sukcesu, dostano ${envelope.code}`);
    return envelope.data;
  };

  const cookScenario = (
    client: Socket,
    recipeId: string,
    householdId: string,
  ) =>
    ack<CookScenarioResponse>(client, 'recipes:cookScenario', {
      recipeId,
      householdId,
    });

  const kotletContent = async (): Promise<unknown> => {
    const rows = await prisma.recipeIngredient.findMany({
      where: { recipeId: KOTLET.recipeId },
      select: { ingredientId: true, name: true },
    });
    const byName = new Map(rows.map((row) => [row.name, row.ingredientId]));
    const resolved = resolveGoldenContent(KOTLET.content, (name) =>
      byName.get(name),
    );
    expect(resolved.errors).toEqual([]);
    return resolved.content;
  };

  const publish = (
    recipeId: string,
    content: unknown,
    rulesVersion = GOLDEN.rulesVersion,
  ) =>
    prisma.$transaction((tx) =>
      publishCookScenario(tx, {
        recipeId,
        content,
        rulesVersion,
        generator: { source: 'golden', file: 'e2e' },
      }),
    );

  const scenarioState = async (recipeId: string) => {
    const recipe = await prisma.recipe.findUniqueOrThrow({
      where: { id: recipeId },
      select: { cookScenarioVersion: true },
    });
    const published = await prisma.recipeCookScenario.count({
      where: { recipeId, status: 'PUBLISHED' },
    });
    return { version: recipe.cookScenarioVersion, published };
  };

  const maxRevision = async (recipeId: string): Promise<bigint> => {
    const rows = await prisma.$queryRaw<{ max: bigint | null }[]>`
      SELECT MAX("revision") AS "max" FROM "CatalogChange" WHERE "recipeId" = ${recipeId}::uuid`;
    return rows[0]?.max ?? 0n;
  };

  beforeAll(async () => {
    process.env.WS_AUTH_MODE = 'strict';
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);

    const kotlet = await prisma.recipe.findUnique({
      where: { id: KOTLET.recipeId },
      select: { cookScenarioVersion: true },
    });
    if (!kotlet)
      throw new Error('baza nie ma przepisu wzorcowego (kotlet de volaille)');
    kotletVersionBefore = kotlet.cookScenarioVersion;
    kotletScenarioIdsBefore = (
      await prisma.recipeCookScenario.findMany({
        where: { recipeId: KOTLET.recipeId },
        select: { id: true },
      })
    ).map((row) => row.id);

    const [sessionA, sessionB] = [
      await devLogin('Ala'),
      await devLogin('Bartek'),
    ];
    socketA = await connect(sessionA.accessToken);
    socketB = await connect(sessionB.accessToken);
    householdA = okData(
      await ack<{ id: string }>(socketA, 'households:create', {
        data: { name: `Dom Ali ${Date.now()}` },
      }),
    ).id;
    householdB = okData(
      await ack<{ id: string }>(socketB, 'households:create', {
        data: { name: `Dom Bartka ${Date.now()}` },
      }),
    ).id;
    createdHouseholdIds.push(householdA, householdB);

    privateRecipeId = okData(
      await ack<{ id: string }>(socketA, 'recipes:create', {
        data: {
          householdId: householdA,
          title: `Tost Ali ${Date.now()}`,
          description: 'Prywatny przepis jednego domu.',
          mealType: 'BREAKFAST',
          suitableMealTypes: ['BREAKFAST'],
          difficulty: 'EASY',
          prepTimeMinutes: 5,
          servings: 1,
          nutritionKcal: 300,
          nutritionProtein: 10,
          nutritionFat: 10,
          nutritionCarbs: 40,
          nutritionFiber: 3,
          nutritionSalt: 1,
        },
      }),
    ).id;
    createdRecipeIds.push(privateRecipeId);
  });

  afterAll(async () => {
    if (originalMode === undefined) delete process.env.WS_AUTH_MODE;
    else process.env.WS_AUTH_MODE = originalMode;
    for (const client of sockets.splice(0)) client.disconnect();
    // Przepis wzorcowy wraca do stanu sprzed testu: nasze wersje znikają,
    // a te, które były, dostają z powrotem swoje statusy.
    await prisma.$transaction(async (tx) => {
      await tx.recipeCookScenario.deleteMany({
        where: {
          recipeId: KOTLET.recipeId,
          id: { notIn: kotletScenarioIdsBefore },
        },
      });
      if (kotletVersionBefore !== null) {
        await tx.recipeCookScenario.updateMany({
          where: { recipeId: KOTLET.recipeId, version: kotletVersionBefore },
          data: { status: 'PUBLISHED' },
        });
      }
      await tx.recipe.update({
        where: { id: KOTLET.recipeId },
        data: { cookScenarioVersion: kotletVersionBefore },
      });
    });
    if (createdRecipeIds.length) {
      await prisma.recipe.deleteMany({
        where: { id: { in: createdRecipeIds } },
      });
    }
    if (createdHouseholdIds.length) {
      await prisma.household.deleteMany({
        where: { id: { in: createdHouseholdIds } },
      });
    }
    if (createdUserIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  it('publikuje wzorzec kotleta: nowa wersja, jeden PUBLISHED, wersja na przepisie, rewizja katalogu', async () => {
    const revisionBefore = await maxRevision(KOTLET.recipeId);
    const content = await kotletContent();
    const result = await publish(KOTLET.recipeId, content);
    expect(result.changed).toBe(true);

    const recipe = await prisma.recipe.findUniqueOrThrow({
      where: { id: KOTLET.recipeId },
      select: { cookScenarioVersion: true },
    });
    expect(recipe.cookScenarioVersion).toBe(result.version);
    const published = await prisma.recipeCookScenario.findMany({
      where: { recipeId: KOTLET.recipeId, status: 'PUBLISHED' },
    });
    expect(published).toHaveLength(1);
    expect(published[0].version).toBe(result.version);
    // Kolumna na `Recipe` przesuwa log katalogu — telefon dostanie deltę.
    expect(await maxRevision(KOTLET.recipeId)).toBeGreaterThan(revisionBefore);

    // Ta sama treść drugi raz: bez nowej wersji i bez zmiany w logu.
    const revisionAfter = await maxRevision(KOTLET.recipeId);
    const again = await publish(KOTLET.recipeId, content);
    expect(again).toEqual({
      recipeId: KOTLET.recipeId,
      version: result.version,
      changed: false,
    });
    expect(await maxRevision(KOTLET.recipeId)).toBe(revisionAfter);
  });

  it('telefon dostaje opublikowany scenariusz z id składników przepisu', async () => {
    const data = okData(
      await cookScenario(socketA, KOTLET.recipeId, householdA),
    );
    const recipe = await prisma.recipe.findUniqueOrThrow({
      where: { id: KOTLET.recipeId },
      select: {
        cookScenarioVersion: true,
        ingredients: { select: { ingredientId: true } },
      },
    });
    expect(data.recipeId).toBe(KOTLET.recipeId);
    expect(data.scenario?.version).toBe(recipe.cookScenarioVersion);
    expect(data.scenario?.content.steps).toHaveLength(12);
    const ids = new Set(recipe.ingredients.map((row) => row.ingredientId));
    const used = data.scenario!.content.steps.flatMap((step) => [
      ...step.ingredients.map((item) => item.ingredientId),
      ...step.mentions,
    ]);
    expect(used.every((id) => ids.has(id))).toBe(true);
  });

  it('nowa treść = nowa wersja, poprzednia RETIRED', async () => {
    const content = (await kotletContent()) as { tips: string[] };
    const changed = {
      ...content,
      tips: [...content.tips.slice(0, 2), 'Nowa rada.'],
    };
    const before = await prisma.recipe.findUniqueOrThrow({
      where: { id: KOTLET.recipeId },
      select: { cookScenarioVersion: true },
    });
    const result = await publish(KOTLET.recipeId, changed);
    expect(result).toEqual({
      recipeId: KOTLET.recipeId,
      version: (before.cookScenarioVersion ?? 0) + 1,
      changed: true,
    });
    const previous = await prisma.recipeCookScenario.findUniqueOrThrow({
      where: {
        recipeId_version: {
          recipeId: KOTLET.recipeId,
          version: before.cookScenarioVersion!,
        },
      },
      select: { status: true },
    });
    expect(previous.status).toBe('RETIRED');
  });

  it('zła treść = VALIDATION_ERROR z listą i nic się nie zapisuje', async () => {
    const before = await prisma.recipeCookScenario.count({
      where: { recipeId: KOTLET.recipeId },
    });
    const content = (await kotletContent()) as { basePortions: number };
    await expect(
      publish(KOTLET.recipeId, { ...content, basePortions: 7 }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    try {
      await publish(KOTLET.recipeId, { ...content, basePortions: 7 });
    } catch (error) {
      expect((error as AppException).details).toContain(
        'basePortions 7 ≠ porcje przepisu 2',
      );
    }
    expect(
      await prisma.recipeCookScenario.count({
        where: { recipeId: KOTLET.recipeId },
      }),
    ).toBe(before);
  });

  it('obcy dom: bramka członkostwa przed odczytem przepisu', async () => {
    const res = await cookScenario(socketA, KOTLET.recipeId, householdB);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('NOT_HOUSEHOLD_MEMBER');
  });

  it('przepis domu A jest dla domu B niewidoczny (404)', async () => {
    const res = await cookScenario(socketB, privateRecipeId, householdB);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('RECIPE_NOT_FOUND');
  });

  it('przepis bez scenariusza: scenario null', async () => {
    const data = okData(
      await cookScenario(socketA, privateRecipeId, householdA),
    );
    expect(data).toEqual({ recipeId: privateRecipeId, scenario: null });
  });

  it('nowa wersja zasad przy tej samej treści = nowa wersja scenariusza', async () => {
    const content = await kotletContent();
    const current = await publish(KOTLET.recipeId, content);
    const next = await publish(KOTLET.recipeId, content, '2099-01-01');
    expect(next).toEqual({
      recipeId: KOTLET.recipeId,
      version: current.version + 1,
      changed: true,
    });
    const row = await prisma.recipeCookScenario.findUniqueOrThrow({
      where: {
        recipeId_version: { recipeId: KOTLET.recipeId, version: next.version },
      },
      select: { rulesVersion: true, status: true },
    });
    expect(row).toEqual({ rulesVersion: '2099-01-01', status: 'PUBLISHED' });
  });

  it('przepisanie składników tymi samymi wierszami NIE unieważnia (liczy się stan przy COMMIT)', async () => {
    const before = await scenarioState(KOTLET.recipeId);
    expect(before.published).toBe(1);
    // Tak robi import JSON: kasuje wszystkie składniki i wstawia je od nowa.
    await prisma.$transaction(async (tx) => {
      const rows = await tx.recipeIngredient.findMany({
        where: { recipeId: KOTLET.recipeId },
        orderBy: { createdAt: 'asc' },
      });
      await tx.recipeIngredient.deleteMany({
        where: { recipeId: KOTLET.recipeId },
      });
      await tx.recipeIngredient.createMany({ data: rows });
    });
    expect(await scenarioState(KOTLET.recipeId)).toEqual(before);
  });

  it('zmiana ilości składnika: STALE, wersja zdjęta, delta katalogu, telefon dostaje null', async () => {
    const before = await scenarioState(KOTLET.recipeId);
    const revisionBefore = await maxRevision(KOTLET.recipeId);
    const butter = await prisma.recipeIngredient.findFirstOrThrow({
      where: { recipeId: KOTLET.recipeId, name: 'masło' },
      select: { id: true, amount: true },
    });
    // Zwykły zapis spoza aplikacji — trigger działa na każdej ścieżce.
    await prisma.recipeIngredient.update({
      where: { id: butter.id },
      data: { amount: butter.amount + 10 },
    });
    try {
      expect(await scenarioState(KOTLET.recipeId)).toEqual({
        version: null,
        published: 0,
      });
      const stale = await prisma.recipeCookScenario.findUniqueOrThrow({
        where: {
          recipeId_version: {
            recipeId: KOTLET.recipeId,
            version: before.version!,
          },
        },
        select: { status: true },
      });
      expect(stale.status).toBe('STALE');
      // Telefon, który trzyma scenariusz offline, dowie się z delty katalogu.
      expect(await maxRevision(KOTLET.recipeId)).toBeGreaterThan(
        revisionBefore,
      );
      expect(
        okData(await cookScenario(socketA, KOTLET.recipeId, householdA)),
      ).toEqual({ recipeId: KOTLET.recipeId, scenario: null });
    } finally {
      await prisma.recipeIngredient.update({
        where: { id: butter.id },
        data: { amount: butter.amount },
      });
    }
    // Po przywróceniu przepisu wzorzec da się opublikować ponownie.
    const again = await publish(KOTLET.recipeId, await kotletContent());
    expect(again.changed).toBe(true);
    expect(await scenarioState(KOTLET.recipeId)).toEqual({
      version: again.version,
      published: 1,
    });
  });

  it('zmiana porcji przepisu domu unieważnia jego scenariusz', async () => {
    const content = {
      schemaVersion: 1,
      basePortions: 1,
      portionUnit: null,
      totalMinutes: 5,
      tips: [],
      nextTimeTip: null,
      steps: [
        {
          id: 's1',
          phase: 'COOK',
          stage: null,
          title: 'Opiecz tost',
          body: 'Włóż chleb do tostera na 2 minuty.',
          ingredients: [],
          mentions: [],
          note: null,
          timer: null,
          during: null,
          scaleNote: null,
        },
      ],
    };
    const result = await publish(privateRecipeId, content);
    expect(result.changed).toBe(true);
    expect(
      okData(await cookScenario(socketA, privateRecipeId, householdA)).scenario
        ?.version,
    ).toBe(result.version);

    await prisma.recipe.update({
      where: { id: privateRecipeId },
      data: { servings: 2 },
    });
    expect(await scenarioState(privateRecipeId)).toEqual({
      version: null,
      published: 0,
    });
    expect(
      okData(await cookScenario(socketA, privateRecipeId, householdA)),
    ).toEqual({
      recipeId: privateRecipeId,
      scenario: null,
    });
  });

  it('przeniesienie składnika do innego przepisu unieważnia OBA scenariusze', async () => {
    // Oba przepisy z opublikowanym scenariuszem: kotlet (wzorzec) i tost domu.
    const kotlet = await publish(KOTLET.recipeId, await kotletContent());
    const toast = await prisma.recipe.findUniqueOrThrow({
      where: { id: privateRecipeId },
      select: { servings: true },
    });
    await publish(privateRecipeId, {
      schemaVersion: 1,
      basePortions: toast.servings,
      portionUnit: null,
      totalMinutes: 5,
      tips: [],
      nextTimeTip: null,
      steps: [
        {
          id: 's1',
          phase: 'COOK',
          stage: null,
          title: 'Opiecz tost',
          body: 'Włóż chleb do tostera na 2 minuty.',
          ingredients: [],
          mentions: [],
          note: null,
          timer: null,
          during: null,
          scaleNote: null,
        },
      ],
    });
    expect((await scenarioState(KOTLET.recipeId)).version).toBe(kotlet.version);
    expect((await scenarioState(privateRecipeId)).published).toBe(1);

    const butter = await prisma.recipeIngredient.findFirstOrThrow({
      where: { recipeId: KOTLET.recipeId, name: 'masło' },
      select: { id: true },
    });
    await prisma.recipeIngredient.update({
      where: { id: butter.id },
      data: { recipeId: privateRecipeId },
    });
    try {
      expect(await scenarioState(KOTLET.recipeId)).toEqual({
        version: null,
        published: 0,
      });
      expect(await scenarioState(privateRecipeId)).toEqual({
        version: null,
        published: 0,
      });
    } finally {
      await prisma.recipeIngredient.update({
        where: { id: butter.id },
        data: { recipeId: KOTLET.recipeId },
      });
    }
  });

  it('wyścig: pierwsza publikacja i zmiana ilości zatwierdzane naraz — scenariusz ze starymi ilościami nie zostaje', async () => {
    // Stan wyjściowy z poprzedniego testu: kotlet BEZ opublikowanego scenariusza.
    expect((await scenarioState(KOTLET.recipeId)).published).toBe(0);
    const content = await kotletContent();
    const butter = await prisma.recipeIngredient.findFirstOrThrow({
      where: { recipeId: KOTLET.recipeId, name: 'masło' },
      select: { id: true, amount: true },
    });
    const gate = () => {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => (open = resolve));
      return { open, opened };
    };
    const edited = gate();
    const published = gate();
    const commitEdit = gate();
    const commitPublish = gate();
    const slow = { maxWait: 20_000, timeout: 20_000 };

    // T2: zmienia ilość masła i czeka z COMMIT.
    const edit = prisma.$transaction(async (tx) => {
      await tx.recipeIngredient.update({
        where: { id: butter.id },
        data: { amount: butter.amount + 10 },
      });
      edited.open();
      await commitEdit.opened;
    }, slow);
    edit.catch(() => edited.open());
    await edited.opened;

    // T1: publikuje, czytając jeszcze stare (zatwierdzone) ilości, i czeka z COMMIT.
    const publication = prisma.$transaction(async (tx) => {
      const result = await publishCookScenario(tx, {
        recipeId: KOTLET.recipeId,
        content,
        rulesVersion: GOLDEN.rulesVersion,
        generator: { source: 'golden', file: 'e2e-race' },
      });
      published.open();
      await commitPublish.opened;
      return result;
    }, slow);
    publication.catch(() => published.open());
    await published.opened;

    // T2 zatwierdza pierwsza: jej trigger czeka na wiersz przepisu (T1),
    // potem T1 zatwierdza publikację.
    commitEdit.open();
    await new Promise((resolve) => setTimeout(resolve, 300));
    commitPublish.open();
    try {
      const [, result] = await Promise.all([edit, publication]);
      expect(result.changed).toBe(true);
      expect(await scenarioState(KOTLET.recipeId)).toEqual({
        version: null,
        published: 0,
      });
      const row = await prisma.recipeCookScenario.findUniqueOrThrow({
        where: {
          recipeId_version: {
            recipeId: KOTLET.recipeId,
            version: result.version,
          },
        },
        select: { status: true },
      });
      expect(row.status).toBe('STALE');
    } finally {
      await prisma.recipeIngredient.update({
        where: { id: butter.id },
        data: { amount: butter.amount },
      });
    }
  });

  it('poprawka samej nazwy składnika nie dotyka scenariusza', async () => {
    const kotlet = await publish(KOTLET.recipeId, await kotletContent());
    const salt = await prisma.recipeIngredient.findFirstOrThrow({
      where: { recipeId: KOTLET.recipeId, name: 'sól' },
      select: { id: true, name: true },
    });
    await prisma.recipeIngredient.update({
      where: { id: salt.id },
      data: { name: 'sól kuchenna' },
    });
    try {
      expect(await scenarioState(KOTLET.recipeId)).toEqual({
        version: kotlet.version,
        published: 1,
      });
    } finally {
      await prisma.recipeIngredient.update({
        where: { id: salt.id },
        data: { name: salt.name },
      });
    }
  });
});
