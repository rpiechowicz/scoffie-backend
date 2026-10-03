import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import type { Prisma } from '@prisma/client';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  resolveGoldenContent,
  type GoldenScenarioFile,
} from '../src/recipes/cook-scenario/cook-scenario.golden';
import type {
  CookScenarioDetail,
  CookScenarioListData,
} from '../src/admin/contract';
import { loadWriterRecipe } from '../src/recipes/cook-scenario/writer/writer.store';
import {
  importScenario,
  portableInputHash,
  type CookScenarioExportEntry,
} from '../src/recipes/cook-scenario/writer/writer.transfer';
import {
  AdminE2ESession,
  createAdminSession,
  useAdminDevGate,
} from './admin-e2e.helper';

/**
 * Scenariusze Gotuj w panelu (E3c) na żywej bazie — wzorzec kotleta na
 * przepisie KATALOGU: publikacja z panelu (walidatory twarde, wersje, delta
 * katalogu), STALE po zmianie przepisu i ponowna publikacja, konflikt
 * wersji, błąd walidacji bez zapisu, wycofanie i step-up. `afterAll`
 * przywraca przepis i jego wiersze scenariuszy sprzed testu.
 */
const GOLDEN = JSON.parse(
  readFileSync(
    join(__dirname, '..', 'prisma', 'catalog', 'cook-scenarios-pl-v1.json'),
    'utf8',
  ),
) as GoldenScenarioFile;
const KOTLET = GOLDEN.scenarios[0];
const ID = KOTLET.recipeId;

describe('Panel: scenariusze Gotuj E2E', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let restoreEnv: () => void;
  let admin: AdminE2ESession;
  let plain: AdminE2ESession;
  let before: {
    version: number | null;
    rows: { id: string; status: string }[];
  };
  let content: Record<string, unknown>;

  const server = () => app.getHttpServer();
  const detail = async () =>
    (
      await request(server())
        .get(`/admin/cook/scenarios/${ID}`)
        .set('Cookie', admin.cookie)
        .expect(200)
    ).body as CookScenarioDetail;
  const publish = (body: object, session = admin) =>
    request(server())
      .post(`/admin/cook/scenarios/${ID}/publish`)
      .set('Cookie', session.cookie)
      .send(body);
  /** Tokeny publikacji ze szczegółu — tak jak wysyła je panel. */
  const tokens = async () => {
    const d = await detail();
    return {
      basedOnVersion: d.latestVersion,
      recipeSignature: d.recipeSignature,
    };
  };
  /** Import z pliku eksportu — wpis z wzorca kotleta, jak z systemu pisania. */
  const importKotlet = async () => {
    const loaded = (await loadWriterRecipe(prisma, ID))!;
    const entry: CookScenarioExportEntry = {
      recipeId: ID,
      title: loaded.recipe.title,
      portableHash: portableInputHash(loaded.recipe),
      content: KOTLET.content,
      generator: { source: 'writer' },
      review: { score: 4, summary: 'e2e' },
      source: {
        scenarioId: '00000000-0000-4000-8000-000000000001',
        version: 1,
      },
    };
    return prisma.$transaction((tx) =>
      importScenario(tx, entry, {
        exportedAt: '2026-10-03T00:00:00Z',
        dryRun: false,
      }),
    );
  };
  const latestVersion = async () =>
    (
      await prisma.recipeCookScenario.aggregate({
        where: { recipeId: ID },
        _max: { version: true },
      })
    )._max.version ?? null;

  beforeAll(async () => {
    restoreEnv = useAdminDevGate();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    admin = await createAdminSession(prisma, { stepUp: true });
    // Ta sama osoba (bramka deweloperska wpuszcza jeden adres), sesja bez step-upu.
    plain = await createAdminSession(prisma, { stepUp: false });

    const recipe = await prisma.recipe.findUniqueOrThrow({
      where: { id: ID },
      select: { cookScenarioVersion: true },
    });
    before = {
      version: recipe.cookScenarioVersion,
      rows: await prisma.recipeCookScenario.findMany({
        where: { recipeId: ID },
        select: { id: true, status: true },
      }),
    };
    const rows = await prisma.recipeIngredient.findMany({
      where: { recipeId: ID },
      select: { ingredientId: true, name: true },
    });
    const byName = new Map(rows.map((row) => [row.name, row.ingredientId]));
    const resolved = resolveGoldenContent(KOTLET.content, (name) =>
      byName.get(name),
    );
    expect(resolved.errors).toEqual([]);
    content = resolved.content as Record<string, unknown>;
  });

  afterAll(async () => {
    const keep = new Set(before.rows.map((row) => row.id));
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Recipe" WHERE "id" = ${ID}::uuid FOR UPDATE`;
      await tx.recipeCookScenario.deleteMany({
        where: { recipeId: ID, id: { notIn: [...keep] } },
      });
      for (const row of before.rows) {
        await tx.recipeCookScenario.update({
          where: { id: row.id },
          data: { status: row.status as 'PUBLISHED' },
        });
      }
      await tx.recipe.update({
        where: { id: ID },
        data: { cookScenarioVersion: before.version },
      });
    });
    restoreEnv();
    await app.close();
  });

  it('publikacja z panelu: walidatory twarde, nowa wersja, stan PUBLISHED na liście', async () => {
    const res = await publish({
      content,
      ...(await tokens()),
    });
    expect(res.status).toBe(201);
    const body = res.body as CookScenarioDetail;
    expect(body.state).toBe('PUBLISHED');
    expect(body.versions[0]).toMatchObject({
      status: 'PUBLISHED',
      source: 'panel',
    });
    expect(body.checks?.errors).toEqual([]);

    const list = (
      await request(server())
        .get('/admin/cook/scenarios')
        .set('Cookie', admin.cookie)
        .expect(200)
    ).body as CookScenarioListData;
    expect(list.items.find((item) => item.recipeId === ID)).toMatchObject({
      state: 'PUBLISHED',
      publishedVersion: body.publishedVersion,
    });
    expect(list.counts.PUBLISHED).toBeGreaterThan(0);
  });

  it('nieaktualna wersja w `basedOnVersion` — 409, nic nie zapisane', async () => {
    const version = await latestVersion();
    // Wersje są, a klient twierdzi, że nie ma żadnej.
    const res = await publish({
      content,
      ...(await tokens()),
      basedOnVersion: null,
    });
    expect(res.status).toBe(409);
    expect(await latestVersion()).toBe(version);
  });

  it('zła treść (cyfra w tytule) — 400 z listą błędów, nic nie zapisane', async () => {
    const version = await latestVersion();
    const broken = structuredClone(content) as {
      steps: { title: string }[];
    };
    broken.steps[0].title = 'Rozbij 4 kotlety';
    const res = await publish({ content: broken, ...(await tokens()) });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('VALIDATION_ERROR');
    expect(
      ((res.body as { details?: string[] }).details ?? []).length,
    ).toBeGreaterThan(0);
    expect(await latestVersion()).toBe(version);
  });

  it('zmiana przepisu = STALE (Gotuj znika z telefonów), ta sama treść wraca ponowną publikacją', async () => {
    // Zmiana treści przepisu — trigger `cook_scenario_staleness` przy COMMIT.
    const recipe = await prisma.recipe.findUniqueOrThrow({
      where: { id: ID },
      select: { title: true },
    });
    await prisma.recipe.update({
      where: { id: ID },
      data: { title: `${recipe.title} (test)` },
    });
    try {
      const stale = await detail();
      expect(stale.state).toBe('STALE');
      expect(stale.publishedVersion).toBeNull();
      // Walidatory na BIEŻĄCYM przepisie — treść dalej pasuje.
      expect(stale.checks?.errors).toEqual([]);

      const res = await publish({
        content,
        ...(await tokens()),
      });
      expect(res.status).toBe(201);
      expect((res.body as CookScenarioDetail).state).toBe('PUBLISHED');
    } finally {
      await prisma.recipe.update({
        where: { id: ID },
        data: { title: recipe.title },
      });
    }
  });

  it('wycofanie: REJECTED, Gotuj znika; drugie wycofanie — 409', async () => {
    // Przywrócenie przepisu dało STALE — publikujemy jeszcze raz.
    await publish({ content, ...(await tokens()) }).expect(201);
    const res = await request(server())
      .post(`/admin/cook/scenarios/${ID}/withdraw`)
      .set('Cookie', admin.cookie)
      .send({ reason: 'Za krótki czas kotletów' });
    expect(res.status).toBe(201);
    expect((res.body as CookScenarioDetail).state).toBe('REJECTED');
    const recipe = await prisma.recipe.findUniqueOrThrow({
      where: { id: ID },
      select: { cookScenarioVersion: true },
    });
    expect(recipe.cookScenarioVersion).toBeNull();
    await request(server())
      .post(`/admin/cook/scenarios/${ID}/withdraw`)
      .set('Cookie', admin.cookie)
      .send({ reason: 'jeszcze raz' })
      .expect(409);
  });

  it('import nie przywraca wycofanego także, gdy nad nim leży nowsza wersja robocza', async () => {
    const top = await prisma.recipeCookScenario.findFirstOrThrow({
      where: { recipeId: ID },
      orderBy: { version: 'desc' },
      select: { version: true, recipeContentHash: true, rulesVersion: true },
    });
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Recipe" WHERE "id" = ${ID}::uuid FOR UPDATE`;
      await tx.recipeCookScenario.create({
        data: {
          recipeId: ID,
          version: top.version + 1,
          status: 'VALIDATED',
          recipeContentHash: top.recipeContentHash,
          rulesVersion: top.rulesVersion,
          content: content as Prisma.InputJsonValue,
          generator: { source: 'writer' },
        },
      });
    });
    expect(await importKotlet()).toBe('WITHDRAWN');
  });

  it('import z pliku nie przywraca scenariusza wycofanego w panelu', async () => {
    expect(await importKotlet()).toBe('WITHDRAWN');
    const recipe = await prisma.recipe.findUniqueOrThrow({
      where: { id: ID },
      select: { cookScenarioVersion: true },
    });
    expect(recipe.cookScenarioVersion).toBeNull();
  });

  it('import z pliku nie nadpisuje wersji z panelu; zmieniony przepis w międzyczasie = 409', async () => {
    const res = await publish({ content, ...(await tokens()) });
    expect(res.status).toBe(201);
    const published = (res.body as CookScenarioDetail).publishedVersion;
    expect(await importKotlet()).toBe('PANEL');
    expect((await detail()).publishedVersion).toBe(published);
    // Wersja z panelu niesie odcisk wejścia — system pisania uzna ją za aktualną.
    const row = await prisma.recipeCookScenario.findFirstOrThrow({
      where: { recipeId: ID, status: 'PUBLISHED' },
      select: { validationReport: true },
    });
    expect((row.validationReport as { inputHash?: string }).inputHash).toMatch(
      /^sha256:/,
    );

    const stale = await publish({
      content,
      ...(await tokens()),
      recipeSignature: 'inny-podpis',
    });
    expect(stale.status).toBe(409);
  });

  it('bez step-upu publikacja i wycofanie są zamknięte', async () => {
    const res = await publish({ content, ...(await tokens()) }, plain);
    expect(res.status).toBe(403);
    await request(server())
      .post(`/admin/cook/scenarios/${ID}/withdraw`)
      .set('Cookie', plain.cookie)
      .send({ reason: 'test' })
      .expect(403);
  });

  it('przepis spoza katalogu albo nieistniejący — 404', async () => {
    await request(server())
      .get('/admin/cook/scenarios/00000000-0000-4000-8000-000000000000')
      .set('Cookie', admin.cookie)
      .expect(404);
  });
});
