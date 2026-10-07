import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { AddressInfo } from 'net';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Udostępnianie przepisów linkiem (29.09.2026) na żywej bazie — kontrakt:
 * `docs/plans/udostepnianie-przepisow/KONTRAKT.md`.
 *
 * Czego nie udowodnią mocki: że trigger naprawdę nadaje slug i alias, że
 * częściowy indeks trzyma JEDEN aktywny link przy wyścigu, że zamek kopii
 * nie daje dwóch kopii, i że każda droga do nieistniejącego przepisu kończy
 * się tym samym 404 — także w publicznym API bez logowania.
 */
type WsEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; message?: string; code: string };

type Session = {
  accessToken: string;
  user: { id: string };
  household: { id: string } | null;
};

type ShareLink = { url: string; kind: string; token: string | null };
type Opened = {
  origin: 'CATALOG' | 'HOUSEHOLD' | 'SHARED';
  recipe: {
    id: string;
    title: string;
    householdId: string | null;
    isFavorite: boolean;
    slug: string | null;
  };
  savedRecipeId: string | null;
  shareToken: string | null;
};
type Saved = {
  recipe: { id: string; title: string; imageUrl: string | null };
  created: boolean;
};

describe('Udostępnianie przepisów E2E', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let baseUrl: string;

  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];
  const sockets: Socket[] = [];
  const originalMode = process.env.WS_AUTH_MODE;
  const originalWebBase = process.env.PUBLIC_WEB_BASE_URL;

  let householdA: string;
  let householdB: string;
  let socketA: Socket;
  let socketB: Socket;
  let ownRecipeId: string;
  let catalog: { id: string; slug: string; title: string };

  const devLogin = async (label: string): Promise<Session> => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `${label} ${stamp}`,
        email: `${label.toLowerCase()}-${stamp}@sharing.local`,
      })
      .expect(201);
    const session = res.body as Session;
    createdUserIds.push(session.user.id);
    if (session.household) createdHouseholdIds.push(session.household.id);
    return session;
  };

  const connect = (token: string): Socket => {
    const client = io(baseUrl, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { token },
    });
    sockets.push(client);
    return client;
  };

  const waitConnect = (client: Socket): Promise<void> =>
    new Promise((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('connect_error', (err: Error) => reject(err));
    });

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
    if (!envelope.ok) {
      throw new Error(`oczekiwano sukcesu, dostano ${envelope.code}`);
    }
    return envelope.data;
  };

  const tokenOf = (link: ShareLink): string => {
    if (!link.token) throw new Error('link bez tokenu');
    return link.token;
  };

  beforeAll(async () => {
    process.env.WS_AUTH_MODE = 'strict';
    process.env.PUBLIC_WEB_BASE_URL = 'https://scoffie.app';
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);

    const catalogRow = await prisma.recipe.findFirst({
      where: { isCatalog: true, isActive: true, slug: { not: null } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, slug: true, title: true },
    });
    if (!catalogRow?.slug) throw new Error('baza nie ma katalogu ze slugami');
    catalog = {
      id: catalogRow.id,
      slug: catalogRow.slug,
      title: catalogRow.title,
    };

    const sessionA = await devLogin('Ala');
    const sessionB = await devLogin('Bartek');
    socketA = connect(sessionA.accessToken);
    socketB = connect(sessionB.accessToken);
    await Promise.all([waitConnect(socketA), waitConnect(socketB)]);

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

    ownRecipeId = okData(
      await ack<{ id: string }>(socketA, 'recipes:create', {
        data: {
          householdId: householdA,
          title: `Zapiekanka Ali ${Date.now()}`,
          description: 'Przepis jednego domu, udostępniany linkiem.',
          mealType: 'DINNER',
          suitableMealTypes: ['DINNER'],
          difficulty: 'EASY',
          prepTimeMinutes: 30,
          servings: 2,
          nutritionKcal: 600,
          nutritionProtein: 25,
          nutritionFat: 20,
          nutritionCarbs: 70,
          nutritionFiber: 5,
          nutritionSalt: 1.5,
          steps: [{ text: 'Pokrój.' }, { text: 'Zapiecz.' }],
        },
      }),
    ).id;
  });

  afterAll(async () => {
    if (originalMode === undefined) delete process.env.WS_AUTH_MODE;
    else process.env.WS_AUTH_MODE = originalMode;
    if (originalWebBase === undefined) delete process.env.PUBLIC_WEB_BASE_URL;
    else process.env.PUBLIC_WEB_BASE_URL = originalWebBase;
    for (const client of sockets.splice(0)) client.disconnect();
    // Przepisy domów (oryginał i kopie) i linki schodzą kaskadą z domami.
    if (createdHouseholdIds.length) {
      await prisma.recipe.deleteMany({
        where: { householdId: { in: createdHouseholdIds } },
      });
      await prisma.household.deleteMany({
        where: { id: { in: createdHouseholdIds } },
      });
    }
    if (createdUserIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  describe('katalog', () => {
    it('shareLink oddaje stały adres ze slugiem i niczego nie zapisuje', async () => {
      const before = await prisma.recipeShare.count();
      const link = okData(
        await ack<ShareLink>(socketA, 'recipes:shareLink', {
          householdId: householdA,
          recipeId: catalog.id,
        }),
      );
      expect(link).toEqual({
        url: `https://scoffie.app/przepis/${catalog.slug}`,
        kind: 'CATALOG',
        token: null,
      });
      expect(await prisma.recipeShare.count()).toBe(before);
    });

    it('openShared po slugu i po UUID → CATALOG z ulubionym domu pytającego', async () => {
      const bySlug = okData(
        await ack<Opened>(socketB, 'recipes:openShared', {
          householdId: householdB,
          slug: catalog.slug,
        }),
      );
      expect(bySlug.origin).toBe('CATALOG');
      expect(bySlug.recipe.id).toBe(catalog.id);
      expect(bySlug.recipe.slug).toBe(catalog.slug);
      const byId = okData(
        await ack<Opened>(socketB, 'recipes:openShared', {
          householdId: householdB,
          slug: catalog.id.toUpperCase(),
        }),
      );
      expect(byId.recipe.id).toBe(catalog.id);
    });

    it('publiczne API: kształt bez autora, domu, id i kroków, z cache', async () => {
      const res = await request(app.getHttpServer())
        .get(`/public/recipes/slug/${catalog.slug}`)
        .expect(200);
      expect(res.headers['cache-control']).toBe('public, max-age=300');
      const body = res.body as Record<string, unknown>;
      expect(body).toMatchObject({
        kind: 'CATALOG',
        slug: catalog.slug,
        title: catalog.title,
      });
      expect(Object.keys(body).sort()).toEqual(
        [
          'allergens',
          'description',
          'difficulty',
          'imageUrl',
          'ingredients',
          'kind',
          'mealType',
          'perServing',
          'prepTimeMinutes',
          'servings',
          'slug',
          'stepCount',
          'thermomix',
          'title',
        ].sort(),
      );
      expect(body.stepCount).toBeGreaterThan(0);
      expect((body.ingredients as unknown[]).length).toBeGreaterThan(0);
    });

    it('zmiana slugu: stary adres dalej prowadzi do przepisu, odpowiedź niesie nowy', async () => {
      const newSlug = `${catalog.slug.slice(0, 60)}-nowy-adres`;
      await prisma.recipe.update({
        where: { id: catalog.id },
        data: { slug: newSlug },
      });
      try {
        const res = await request(app.getHttpServer())
          .get(`/public/recipes/slug/${catalog.slug}`)
          .expect(200);
        expect(res.body.slug).toBe(newSlug);
        const opened = okData(
          await ack<Opened>(socketA, 'recipes:openShared', {
            householdId: householdA,
            slug: catalog.slug,
          }),
        );
        expect(opened.recipe.id).toBe(catalog.id);
        // Stary adres innego przepisu nie może zostać przejęty.
        const other = await prisma.recipe.findFirst({
          where: { isCatalog: true, id: { not: catalog.id } },
          select: { id: true },
        });
        await expect(
          prisma.recipe.update({
            where: { id: other!.id },
            data: { slug: catalog.slug },
          }),
        ).rejects.toThrow();
      } finally {
        // Powrót do starego adresu zdejmuje go z aliasów (trigger).
        await prisma.recipe.update({
          where: { id: catalog.id },
          data: { slug: catalog.slug },
        });
        await prisma.recipeSlugAlias.deleteMany({
          where: { recipeId: catalog.id, slug: newSlug },
        });
      }
      expect(
        await prisma.recipeSlugAlias.count({
          where: { slug: catalog.slug },
        }),
      ).toBe(0);
    });

    it('nowy przepis katalogu dostaje slug z tytułu, z sufiksem przy kolizji', async () => {
      const source = await prisma.recipe.findUniqueOrThrow({
        where: { id: catalog.id },
        select: { authorId: true, householdId: true },
      });
      const twin = await prisma.recipe.create({
        data: {
          title: catalog.title,
          mealType: 'DINNER',
          isCatalog: true,
          isActive: false,
          authorId: source.authorId,
          householdId: source.householdId,
        },
        select: { id: true, slug: true },
      });
      try {
        expect(twin.slug).toMatch(new RegExp(`^${catalog.slug}-\\d+$`));
      } finally {
        await prisma.recipe.delete({ where: { id: twin.id } });
      }
    });
  });

  describe('przepis gospodarstwa', () => {
    let token: string;

    it('shareLink tworzy JEDEN link — także przy wyścigu pięciu kliknięć', async () => {
      const links = await Promise.all(
        Array.from({ length: 5 }, () =>
          ack<ShareLink>(socketA, 'recipes:shareLink', {
            householdId: householdA,
            recipeId: ownRecipeId,
          }).then(okData),
        ),
      );
      const tokens = new Set(links.map(tokenOf));
      expect(tokens.size).toBe(1);
      token = tokenOf(links[0]);
      expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(links[0]).toMatchObject({
        kind: 'HOUSEHOLD',
        url: `https://scoffie.app/przepis/u/${token}`,
      });
      expect(
        await prisma.recipeShare.count({
          where: { recipeId: ownRecipeId, revokedAt: null },
        }),
      ).toBe(1);
    });

    it('stan domu niesie shareUrl', async () => {
      const state = okData(
        await ack<{
          recipes: {
            id: string;
            shareUrl: string | null;
            imageUrl: string | null;
          }[];
        }>(socketA, 'recipes:householdState', { householdId: householdA }),
      );
      const own = state.recipes.find((r) => r.id === ownRecipeId);
      expect(own?.shareUrl).toBe(`https://scoffie.app/przepis/u/${token}`);
      // Audyt 5.09.2026, 2.2.5: przepis domu bez zdjęcia NIE dostaje adresu
      // generatora z tytułem i opisem w ścieżce — klient pokazuje zaślepkę.
      expect(own?.imageUrl).toBeNull();
      expect(own).not.toHaveProperty('isCatalog');
    });

    it('obcy dom nie wygeneruje linku do cudzego przepisu', async () => {
      const response = await ack(socketB, 'recipes:shareLink', {
        householdId: householdB,
        recipeId: ownRecipeId,
      });
      expect(response).toMatchObject({ ok: false, code: 'RECIPE_NOT_FOUND' });
    });

    it('publiczne API po tokenie: SHARED, bez slugu, z liczbą kroków', async () => {
      const res = await request(app.getHttpServer())
        .get(`/public/recipes/shared/${token}`)
        .expect(200);
      expect(res.headers['cache-control']).toBe('public, max-age=60');
      expect(res.body).toMatchObject({
        kind: 'SHARED',
        slug: null,
        stepCount: 2,
        servings: 2,
        perServing: { kcal: 300 },
        // Bez zdjęcia: strona pokazuje kartę marki, nie generator z treścią.
        imageUrl: null,
      });
    });

    it('obcy dom otwiera link: SHARED, bez cudzego domu, a findById dalej 404', async () => {
      const opened = okData(
        await ack<Opened>(socketB, 'recipes:openShared', {
          householdId: householdB,
          token,
        }),
      );
      expect(opened.origin).toBe('SHARED');
      expect(opened.recipe.id).toBe(ownRecipeId);
      expect(opened.recipe.householdId).toBeNull();
      expect(opened.recipe.isFavorite).toBe(false);
      expect(opened.savedRecipeId).toBeNull();
      expect(opened.shareToken).toBe(token);
      const byId = await ack(socketB, 'recipes:findById', {
        id: ownRecipeId,
        householdId: householdB,
      });
      expect(byId).toMatchObject({ ok: false, code: 'RECIPE_NOT_FOUND' });
    });

    it('własny dom otwiera swój link jako HOUSEHOLD', async () => {
      const opened = okData(
        await ack<Opened>(socketA, 'recipes:openShared', {
          householdId: householdA,
          token,
        }),
      );
      expect(opened.origin).toBe('HOUSEHOLD');
      expect(opened.recipe.householdId).toBe(householdA);
    });

    it('bez członkostwa w domu z koperty — NOT_HOUSEHOLD_MEMBER', async () => {
      const response = await ack(socketB, 'recipes:openShared', {
        householdId: householdA,
        token,
      });
      expect(response).toMatchObject({
        ok: false,
        code: 'NOT_HOUSEHOLD_MEMBER',
      });
    });

    it('„Zapisz u siebie”: jedna kopia przy równoczesnych kliknięciach, potem ta sama', async () => {
      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          ack<Saved>(socketB, 'recipes:saveShared', {
            householdId: householdB,
            token,
          }).then(okData),
        ),
      );
      const ids = new Set(results.map((r) => r.recipe.id));
      expect(ids.size).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      const copyId = results[0].recipe.id;
      expect(copyId).not.toBe(ownRecipeId);

      const copy = await prisma.recipe.findUniqueOrThrow({
        where: { id: copyId },
        select: {
          householdId: true,
          isCatalog: true,
          copiedFromRecipeId: true,
          title: true,
          sourceInstructions: true,
          imageUrl: true,
        },
      });
      expect(copy).toMatchObject({
        householdId: householdB,
        isCatalog: false,
        copiedFromRecipeId: ownRecipeId,
      });
      // Zdjęcie przechodzi jako rozwiązany adres — kopia z nowym id nie może
      // dostać innego obrazka niż ten, który widział odbiorca. Przepis domu
      // bez zdjęcia: `null` w obu (bez generatora, audyt 2.2.5).
      const source = okData(
        await ack<{ imageUrl: string | null }>(socketA, 'recipes:findById', {
          id: ownRecipeId,
          householdId: householdA,
        }),
      );
      expect(source.imageUrl).toBeNull();
      expect(copy.imageUrl).toBe(source.imageUrl);

      const again = okData(
        await ack<Saved>(socketB, 'recipes:saveShared', {
          householdId: householdB,
          token,
        }),
      );
      expect(again).toMatchObject({ created: false, recipe: { id: copyId } });

      const reopened = okData(
        await ack<Opened>(socketB, 'recipes:openShared', {
          householdId: householdB,
          token,
        }),
      );
      expect(reopened.savedRecipeId).toBe(copyId);

      // Kopia to zwykły przepis domu B — widać ją w jego stanie.
      const state = okData(
        await ack<{ recipes: { id: string }[] }>(
          socketB,
          'recipes:householdState',
          { householdId: householdB },
        ),
      );
      expect(state.recipes.map((r) => r.id)).toContain(copyId);
    });

    it('własny link zapisany we własnym domu → oryginał, bez kopii', async () => {
      const saved = okData(
        await ack<Saved>(socketA, 'recipes:saveShared', {
          householdId: householdA,
          token,
        }),
      );
      expect(saved).toMatchObject({
        created: false,
        recipe: { id: ownRecipeId },
      });
    });

    it('liczniki: otwarcia i zapis, bez osób', async () => {
      const events = await prisma.recipeShareEvent.groupBy({
        by: ['kind'],
        where: { recipeId: ownRecipeId },
        _count: { _all: true },
      });
      const count = (kind: string) =>
        events.find((e) => e.kind === kind)?._count._all ?? 0;
      expect(count('OPENED')).toBeGreaterThanOrEqual(3);
      expect(count('SAVED')).toBe(1);
      okData(
        await ack(socketA, 'recipes:shared', {
          householdId: householdA,
          recipeId: ownRecipeId,
        }),
      );
      expect(
        await prisma.recipeShareEvent.count({
          where: { recipeId: ownRecipeId, kind: 'SHARED' },
        }),
      ).toBe(1);
      // Cudzego przepisu nie da się „udostępnić” w liczniku.
      const foreign = await ack(socketB, 'recipes:shared', {
        householdId: householdB,
        recipeId: ownRecipeId,
      });
      expect(foreign).toMatchObject({ ok: false, code: 'RECIPE_NOT_FOUND' });
    });

    it('„Wyłącz link” gasi go wszędzie, a następne udostępnienie daje nowy token', async () => {
      const revoked = okData(
        await ack<{ revoked: boolean }>(socketA, 'recipes:revokeShare', {
          householdId: householdA,
          recipeId: ownRecipeId,
        }),
      );
      expect(revoked).toEqual({ revoked: true });
      await request(app.getHttpServer())
        .get(`/public/recipes/shared/${token}`)
        .expect(404);
      expect(
        await ack(socketB, 'recipes:openShared', {
          householdId: householdB,
          token,
        }),
      ).toMatchObject({ ok: false, code: 'RECIPE_NOT_FOUND' });
      expect(
        okData(
          await ack<{ revoked: boolean }>(socketA, 'recipes:revokeShare', {
            householdId: householdA,
            recipeId: ownRecipeId,
          }),
        ),
      ).toEqual({ revoked: false });

      const fresh = okData(
        await ack<ShareLink>(socketA, 'recipes:shareLink', {
          householdId: householdA,
          recipeId: ownRecipeId,
        }),
      );
      expect(tokenOf(fresh)).not.toBe(token);
      token = tokenOf(fresh);
    });

    it('wycofany przepis: link martwy, choć aktywny', async () => {
      await prisma.recipe.update({
        where: { id: ownRecipeId },
        data: { isActive: false },
      });
      try {
        await request(app.getHttpServer())
          .get(`/public/recipes/shared/${token}`)
          .expect(404);
      } finally {
        await prisma.recipe.update({
          where: { id: ownRecipeId },
          data: { isActive: true },
        });
      }
    });
  });

  // Review 7.10.2026: kopia sprzed poprawki 2.2.5 utrwaliła w `imageUrl`
  // adres generatora z tytułem i opisem prywatnego przepisu.
  describe('przepis domu z UTRWALONYM adresem generatora', () => {
    const stored =
      'https://image.pollinations.ai/prompt/professional%20food%20photo%2C%20Tajny%20gulasz?seed=scoffie-x';
    let legacyId: string;
    let legacyToken: string;

    beforeAll(async () => {
      legacyId = okData(
        await ack<{ id: string }>(socketA, 'recipes:create', {
          data: {
            householdId: householdA,
            title: `Tajny gulasz ${Date.now()}`,
            description: 'Kopia zapisana przez starą wersję.',
            mealType: 'DINNER',
            suitableMealTypes: ['DINNER'],
            difficulty: 'EASY',
            prepTimeMinutes: 30,
            servings: 2,
            nutritionKcal: 600,
            nutritionProtein: 25,
            nutritionFat: 20,
            nutritionCarbs: 70,
            nutritionFiber: 5,
            nutritionSalt: 1.5,
            steps: [{ text: 'Duś.' }],
          },
        }),
      ).id;
      await prisma.recipe.update({
        where: { id: legacyId },
        data: { imageUrl: stored },
      });
      legacyToken = tokenOf(
        okData(
          await ack<ShareLink>(socketA, 'recipes:shareLink', {
            householdId: householdA,
            recipeId: legacyId,
          }),
        ),
      );
    });

    it('API oddaje null: szczegół, stan domu, publiczny link', async () => {
      const detail = okData(
        await ack<{ imageUrl: string | null }>(socketA, 'recipes:findById', {
          id: legacyId,
          householdId: householdA,
        }),
      );
      expect(detail.imageUrl).toBeNull();
      const state = okData(
        await ack<{ recipes: { id: string; imageUrl: string | null }[] }>(
          socketA,
          'recipes:householdState',
          { householdId: householdA },
        ),
      );
      expect(state.recipes.find((r) => r.id === legacyId)?.imageUrl).toBeNull();
      const res = await request(app.getHttpServer())
        .get(`/public/recipes/shared/${legacyToken}`)
        .expect(200);
      expect(res.body.imageUrl).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain('pollinations');
    });

    it('kopia „Zapisz u siebie” nie dziedziczy adresu generatora', async () => {
      const saved = okData(
        await ack<Saved>(socketB, 'recipes:saveShared', {
          householdId: householdB,
          token: legacyToken,
        }),
      );
      expect(saved.recipe).toMatchObject({ imageUrl: null });
      const copy = await prisma.recipe.findUniqueOrThrow({
        where: { id: saved.recipe.id },
        select: { imageUrl: true },
      });
      expect(copy.imageUrl).toBeNull();
    });
  });

  describe('jedna odpowiedź na każdy zły adres', () => {
    it.each([
      ['/public/recipes/shared/nie-token'],
      ['/public/recipes/shared/AAAAAAAAAAAAAAAAAAAAAA'],
      ['/public/recipes/slug/NIE_SLUG'],
      ['/public/recipes/slug/tego-przepisu-nie-ma-na-pewno'],
      ['/public/recipes/slug/00000000-0000-4000-8000-000000000000'],
    ])('%s → 404 RECIPE_NOT_FOUND', async (path) => {
      const res = await request(app.getHttpServer()).get(path).expect(404);
      expect(res.body.code).toBe('RECIPE_NOT_FOUND');
      expect(res.body.message).toBe('Ten przepis nie jest już dostępny.');
      // „Nie ma” nie może utknąć w cache — przepis mógł zaraz powstać.
      expect(res.headers['cache-control'] ?? '').not.toMatch(/public/);
    });

    it.each([
      ['slug i token naraz', { slug: 'a', token: 'AAAAAAAAAAAAAAAAAAAAAA' }],
      ['ani slugu, ani tokenu', {}],
    ])('openShared: %s → RECIPE_NOT_FOUND', async (_label, link) => {
      const response = await ack(socketA, 'recipes:openShared', {
        householdId: householdA,
        ...link,
      });
      expect(response).toMatchObject({ ok: false, code: 'RECIPE_NOT_FOUND' });
    });
  });
});
