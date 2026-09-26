import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  CatalogChangesPage,
  CatalogItem,
  CatalogSnapshotPage,
  CatalogSyncService,
} from '../src/recipes/catalog-sync.service';
import { RecipesService } from '../src/recipes/recipes.service';

/**
 * Synchronizacja publicznego katalogu na żywej bazie (workstream, Etap 4A):
 * log `CatalogChange` z triggerów, snapshot + delta, tombstone'y, RESET.
 * Numery w opisach = testy obowiązkowe z polecenia Etapu 4.
 *
 * Suita zakłada własny dom „katalogowy" i ponad 5100 przepisów katalogu,
 * a na końcu je kasuje (trigger zapisze tombstone'y — w logu to poprawny
 * ślad, klient usunie przepisy, których i tak nie zna).
 */
type SnapshotOk = Extract<CatalogSnapshotPage, { mode: 'SNAPSHOT' }>;
type DeltaOk = Extract<CatalogChangesPage, { mode: 'DELTA' }>;

const BULK = 5100;

describe('Synchronizacja katalogu E2E (Etap 4A)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let sync: CatalogSyncService;
  let recipes: RecipesService;
  let authorId: string;
  let catalogHouseholdId: string;
  let privateHouseholdId: string;
  let ingredientId: string;
  let bulkIds: string[] = [];

  const snapshotAll = async (
    limit = 500,
    between?: (page: number) => Promise<void>,
  ) => {
    let cursor: string | null = null;
    let revision: string | undefined;
    const items: CatalogItem[] = [];
    let pages = 0;
    for (;;) {
      const page = (await sync.snapshot({
        ...(revision ? { revision } : {}),
        ...(cursor ? { cursor } : {}),
        limit,
      })) as SnapshotOk;
      expect(page.mode).toBe('SNAPSHOT');
      if (revision) expect(page.revision).toBe(revision);
      revision = page.revision;
      items.push(...page.items);
      pages += 1;
      cursor = page.nextCursor;
      if (!cursor) break;
      await between?.(pages);
    }
    return { items, revision: revision, pages };
  };

  const deltaAll = async (sinceRevision: string, limit = 500) => {
    let cursor: string | null = null;
    let untilRevision: string | undefined;
    const upserts: CatalogItem[] = [];
    const tombstones: string[] = [];
    let pages = 0;
    for (;;) {
      const page = (await sync.changes({
        sinceRevision,
        ...(untilRevision ? { untilRevision } : {}),
        ...(cursor ? { cursor } : {}),
        limit,
      })) as DeltaOk;
      expect(page.mode).toBe('DELTA');
      if (untilRevision) expect(page.revision).toBe(untilRevision);
      untilRevision = page.revision;
      upserts.push(...page.upserts);
      tombstones.push(...page.tombstones);
      pages += 1;
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return { upserts, tombstones, revision: untilRevision, pages };
  };

  const createCatalogRecipe = async (title: string) =>
    prisma.recipe.create({
      data: {
        title,
        mealType: 'DINNER',
        suitableMealTypes: ['DINNER'],
        isCatalog: true,
        isActive: true,
        authorId,
        householdId: catalogHouseholdId,
        nutritionKcal: 600,
        servings: 2,
      },
      select: { id: true },
    });

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    sync = moduleRef.get(CatalogSyncService);
    recipes = moduleRef.get(RecipesService);

    const stamp = `${Date.now()}-${randomUUID().slice(0, 6)}`;
    authorId = (
      await prisma.user.create({
        data: {
          displayName: `Sync ${stamp}`,
          email: `sync-${stamp}@sync.local`,
          authProvider: 'DEV',
        },
        select: { id: true },
      })
    ).id;
    catalogHouseholdId = (
      await prisma.household.create({
        data: { name: `Katalog sync ${stamp}`, createdById: authorId },
        select: { id: true },
      })
    ).id;
    privateHouseholdId = (
      await prisma.household.create({
        data: { name: `Dom sync ${stamp}`, createdById: authorId },
        select: { id: true },
      })
    ).id;
    await prisma.membership.create({
      data: {
        userId: authorId,
        householdId: privateHouseholdId,
        role: 'OWNER',
      },
    });
    ingredientId = (
      await prisma.ingredient.create({
        data: {
          name: `Składnik sync ${stamp}`,
          normalizedName: `skladnik sync ${stamp}`,
          category: 'warzywa',
        },
        select: { id: true },
      })
    ).id;

    // 5100 przepisów katalogu — jednym `createMany` (trigger per wiersz).
    const rows: Prisma.RecipeCreateManyInput[] = Array.from(
      { length: BULK },
      (_, i) => ({
        id: randomUUID(),
        title: `Sync ${stamp} ${i}`,
        mealType: 'LUNCH',
        suitableMealTypes: ['LUNCH'],
        isCatalog: true,
        isActive: true,
        authorId,
        householdId: catalogHouseholdId,
        nutritionKcal: 500,
        servings: 2,
      }),
    );
    await prisma.recipe.createMany({ data: rows });
    bulkIds = rows.map((row) => row.id!);
  }, 120_000);

  afterAll(async () => {
    await prisma.recipe.deleteMany({
      where: { householdId: { in: [catalogHouseholdId, privateHouseholdId] } },
    });
    await prisma.ingredient.deleteMany({ where: { id: ingredientId } });
    await prisma.household.deleteMany({
      where: { id: { in: [catalogHouseholdId, privateHouseholdId] } },
    });
    await prisma.user.deleteMany({ where: { id: authorId } });
    await moduleRef.close();
  }, 120_000);

  it('1./2./13. snapshot oddaje WSZYSTKIE aktywne przepisy katalogu (>5100, bez limitu 4000), bez braków i duplikatów', async () => {
    const expected = await prisma.recipe.count({
      where: { isCatalog: true, isActive: true },
    });
    const { items, pages } = await snapshotAll(500);
    expect(expected).toBeGreaterThanOrEqual(BULK);
    expect(items.length).toBe(expected);
    expect(items.length).toBeGreaterThan(4000);
    const ids = items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of bulkIds) expect(ids).toContain(id);
    expect(pages).toBe(Math.ceil(expected / 500));
    // Snapshot to wyłącznie katalog — bez przepisów gospodarstw.
    const privateCount = await prisma.recipe.count({
      where: { id: { in: ids }, isCatalog: false },
    });
    expect(privateCount).toBe(0);
  });

  it('3./4./5./11. klient ma R: brak zmian → pusta delta; zmiana JEDNEGO przepisu → delta zwraca tylko jego', async () => {
    const { revision } = await snapshotAll(500);
    const empty = await deltaAll(revision);
    expect(empty).toMatchObject({ upserts: [], tombstones: [], revision });

    const target = bulkIds[17];
    await prisma.recipe.update({
      where: { id: target },
      data: { title: 'Zmieniony tytuł synchronizacji' },
    });
    const delta = await deltaAll(revision);
    expect(delta.upserts.map((item) => item.id)).toEqual([target]);
    expect(delta.upserts[0].title).toBe('Zmieniony tytuł synchronizacji');
    expect(delta.tombstones).toEqual([]);
    expect(delta.revision).not.toBe(revision);
  });

  it('6. wycofanie i twarde usunięcie → tombstone', async () => {
    const start = await sync.currentRevision();
    const retired = bulkIds[18];
    const removed = (await createCatalogRecipe('Do skasowania')).id;
    const afterCreate = await sync.currentRevision();
    await prisma.recipe.update({
      where: { id: retired },
      data: { isActive: false },
    });
    await prisma.recipe.delete({ where: { id: removed } });
    const delta = await deltaAll(afterCreate);
    expect(delta.tombstones.sort()).toEqual([retired, removed].sort());
    expect(delta.upserts).toEqual([]);
    // Od stanu sprzed utworzenia: przepis, który powstał i zniknął, to też tombstone.
    const full = await deltaAll(start);
    expect(full.tombstones).toContain(removed);
  });

  it('7. nowy przepis katalogu → upsert', async () => {
    const start = await sync.currentRevision();
    const created = (await createCatalogRecipe('Nowy w katalogu')).id;
    const delta = await deltaAll(start);
    expect(delta.upserts.map((item) => item.id)).toEqual([created]);
  });

  it('8. składnik, tag diety i makra przesuwają rewizję i wracają w delcie', async () => {
    const target = bulkIds[19];
    let start = await sync.currentRevision();
    await prisma.recipeIngredient.create({
      data: {
        recipeId: target,
        ingredientId,
        name: 'Składnik sync',
        amount: 100,
        unit: 'g',
        normalizedAmount: 100,
        normalizedUnit: 'g',
        department: 'warzywa',
      },
    });
    expect((await deltaAll(start)).upserts.map((item) => item.id)).toEqual([
      target,
    ]);

    start = await sync.currentRevision();
    await prisma.recipe.update({
      where: { id: target },
      data: { dietTags: ['MEAT'] },
    });
    expect((await deltaAll(start)).upserts.map((item) => item.id)).toEqual([
      target,
    ]);

    start = await sync.currentRevision();
    await prisma.recipe.update({
      where: { id: target },
      data: { nutritionKcal: 777 },
    });
    const delta = await deltaAll(start);
    expect(delta.upserts[0]).toMatchObject({ id: target, nutritionKcal: 777 });

    // Zapis bez zmiany treści (sam `updatedAt`) NIE przesuwa rewizji.
    start = await sync.currentRevision();
    await prisma.recipe.update({
      where: { id: target },
      data: { nutritionKcal: 777 },
    });
    expect(await sync.currentRevision()).toBe(start);
  });

  it('9./10. ulubione i przepis GOSPODARSTWA nie przesuwają publicznej rewizji', async () => {
    const start = await sync.currentRevision();
    await recipes.setFavorite(authorId, {
      recipeId: bulkIds[20],
      householdId: privateHouseholdId,
      isFavorite: true,
    });
    const own = await prisma.recipe.create({
      data: {
        title: 'Prywatny przepis domu',
        mealType: 'DINNER',
        isCatalog: false,
        authorId,
        householdId: privateHouseholdId,
      },
      select: { id: true },
    });
    await prisma.recipe.update({
      where: { id: own.id },
      data: { title: 'Prywatny, poprawiony' },
    });
    expect(await sync.currentRevision()).toBe(start);
    const delta = await deltaAll(start);
    expect(delta.upserts).toEqual([]);
    expect(delta.tombstones).toEqual([]);
    // Dom dostaje swoje przepisy i ulubione osobno.
    const state = await recipes.householdState(authorId, privateHouseholdId);
    expect(state.recipes.map((recipe) => recipe.id)).toContain(own.id);
    expect(state.favoriteRecipeIds).toContain(bulkIds[20]);
  });

  it('12. nieznana, przyszła i wyczyszczona rewizja → RESET_REQUIRED (snapshotRequired)', async () => {
    const current = await sync.currentRevision();
    const [epoch, number] = [
      current.slice(0, current.lastIndexOf('.')),
      BigInt(current.slice(current.lastIndexOf('.') + 1)),
    ];
    const unknown = await sync.changes({
      sinceRevision: `${randomUUID()}.1`,
    });
    expect(unknown).toMatchObject({
      mode: 'RESET_REQUIRED',
      snapshotRequired: true,
      reason: 'UNKNOWN_REVISION',
    });
    const garbage = await sync.changes({ sinceRevision: 'cokolwiek' });
    expect(garbage.mode).toBe('RESET_REQUIRED');
    const future = await sync.changes({
      sinceRevision: `${epoch}.${(number + 1000n).toString()}`,
    });
    expect(future).toMatchObject({ reason: 'FUTURE_REVISION' });

    const state = await prisma.catalogSyncState.findUniqueOrThrow({
      where: { id: 1 },
    });
    try {
      await prisma.catalogSyncState.update({
        where: { id: 1 },
        data: { minRevision: number },
      });
      const pruned = await sync.changes({
        sinceRevision: `${epoch}.${(number - 1n).toString()}`,
      });
      expect(pruned).toMatchObject({ reason: 'REVISION_PRUNED' });
    } finally {
      await prisma.catalogSyncState.update({
        where: { id: 1 },
        data: { minRevision: state.minRevision },
      });
    }
  });

  it('14. delta stronami: 25 zmian po 10 — bez braków i duplikatów, rewizja ustalona na pierwszej stronie', async () => {
    const start = await sync.currentRevision();
    const changed = bulkIds.slice(100, 125);
    for (const id of changed) {
      await prisma.recipe.update({
        where: { id },
        data: { prepTimeMinutes: 42 },
      });
    }
    const delta = await deltaAll(start, 10);
    expect(delta.pages).toBe(3);
    const ids = delta.upserts.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual([...changed].sort());
  });

  it('15. zmiana W TRAKCIE snapshotu nie rusza znacznika; następna delta ją dowozi', async () => {
    const changedMidway = bulkIds[4000];
    let createdMidway = '';
    const { revision } = await snapshotAll(1000, async (page) => {
      if (page === 2) {
        await prisma.recipe.update({
          where: { id: changedMidway },
          data: { title: 'Zmiana w trakcie snapshotu' },
        });
        createdMidway = (await createCatalogRecipe('Nowy w trakcie')).id;
      }
    });
    // Znacznik z pierwszej strony — przed zmianami.
    expect(revision).not.toBe(await sync.currentRevision());
    const delta = await deltaAll(revision);
    const ids = delta.upserts.map((item) => item.id);
    expect(ids).toContain(changedMidway);
    expect(ids).toContain(createdMidway);
  });

  it('16. ta sama delta zastosowana dwa razy daje ten sam stan (logika klienta)', async () => {
    const snapshot = await snapshotAll(1000);
    await prisma.recipe.update({
      where: { id: bulkIds[30] },
      data: { title: 'Idempotencja' },
    });
    await prisma.recipe.update({
      where: { id: bulkIds[31] },
      data: { isActive: false },
    });
    const delta = await deltaAll(snapshot.revision);
    // Ta sama reguła, co `CatalogSyncApplier` w iOS: upsert nadpisuje po id,
    // tombstone usuwa (także nieznane id), rewizja dopiero po całości.
    const apply = (state: Map<string, CatalogItem>) => {
      for (const item of delta.upserts) state.set(item.id, item);
      for (const id of delta.tombstones) state.delete(id);
      return state;
    };
    const base = () =>
      new Map(snapshot.items.map((item) => [item.id, item] as const));
    const once = apply(base());
    const twice = apply(apply(base()));
    expect([...twice.keys()].sort()).toEqual([...once.keys()].sort());
    expect(twice.get(bulkIds[30])?.title).toBe('Idempotencja');
    expect(twice.has(bulkIds[31])).toBe(false);
    // I po zastosowaniu klient jest aktualny: pusta delta od nowej rewizji.
    expect((await deltaAll(delta.revision)).upserts).toEqual([]);
  });
});
