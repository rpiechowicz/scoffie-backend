/**
 * Kasuje WSZYSTKICH użytkowników i WSZYSTKIE gospodarstwa — oprócz katalogu
 * przepisów.
 *
 * Po co: wymusić, żeby każdy zalogował się od nowa i przeszedł przewodnik
 * „Poznaj aplikację” oraz kreator profilu od zera. Usunięcie użytkownika
 * kaskaduje na `RefreshToken`, więc sesje na telefonach przestają się
 * odnawiać; access token dożywa swojego TTL i telefon wypada do ekranu
 * logowania.
 *
 * Dlaczego to NIE jest zwykłe „skasuj tabelę User i Household":
 *
 *   `Recipe.household` i `Recipe.author` mają `onDelete: Cascade`. Katalog
 *   (te ~60 przepisów, które widzą wszystkie gospodarstwa) wisi na jakimś
 *   gospodarstwie i na jakimś koncie autora — kasowanie „wszystkiego"
 *   zabrałoby go razem z nimi, wraz ze składnikami i obrazkami w R2, które
 *   są nazwane id-em przepisu. Dlatego skrypt NAJPIERW przenosi katalog na
 *   dedykowane konto bota i dedykowane gospodarstwo (to samo, którego używa
 *   `import-recipes-from-json.ts`), a dopiero potem kasuje resztę. Dzięki
 *   temu nie trzeba zgadywać, czy katalog nie leży czasem w prywatnym
 *   gospodarstwie któregoś z żywych użytkowników — bo po przeniesieniu już
 *   nie leży.
 *
 * Użycie (domyślnie DRY-RUN — raport bez kasowania):
 *   railway run --service Backend pnpm accounts:reset
 *   railway run --service Backend RESET_ACCOUNTS_WRITE=true \
 *     RESET_ACCOUNTS_CONFIRM=<dzisiejsza data UTC, YYYY-MM-DD> \
 *     RESET_ACCOUNTS_ALLOW_HOST=<host:port z DATABASE_URL> pnpm accounts:reset
 *
 * Zapis żąda `--write` albo `RESET_ACCOUNTS_WRITE=true`, ale to nie
 * wystarcza: strażnik (`scripts/lib/reset-accounts-guard.js`) wymaga
 * dzisiejszej daty UTC w `RESET_ACCOUNTS_CONFIRM` (potwierdzenie wygasa
 * o północy) i — dla bazy spoza tej maszyny — hosta z `DATABASE_URL` w
 * `RESET_ACCOUNTS_ALLOW_HOST`. Host jest wypisywany PRZED kasowaniem.
 * Zmienna zamiast argumentu, bo argument musi przejść przez trzy warstwy
 * (`railway` → `pnpm` → `tsx`) i każda z nich ma własne zdanie na temat
 * `--`; przy operacji, której nie da się cofnąć, „flaga nie doszła" jest
 * lepszym błędem niż „flaga doszła, choć nie miała".
 *
 * UWAGA — to nie kończy sesji na telefonach. Access token żyje domyślnie
 * 30 dni (`JWT_EXPIRES_IN`) i sam podpis pozostaje ważny, mimo że konta
 * już nie ma. Żeby wylogowało WSZYSTKICH natychmiast, po tym skrypcie
 * podmień `JWT_SECRET` na Railway — patrz `commands.txt`.
 */
import { Prisma, PrismaClient } from '@prisma/client';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { decideResetAccounts } = require('./lib/reset-accounts-guard.js') as {
  decideResetAccounts: (input: {
    env: NodeJS.ProcessEnv;
    argv?: string[];
    now?: Date;
  }) => {
    requested: boolean;
    allowed: boolean;
    host: string | null;
    reason: string;
  };
};

const prisma = new PrismaClient();

const CATALOG_OWNER_USER_ID =
  process.env.RECIPE_IMPORT_OWNER_USER_ID ??
  '11111111-1111-4111-8111-111111111111';
const CATALOG_OWNER_DISPLAY_NAME =
  process.env.RECIPE_IMPORT_OWNER_DISPLAY_NAME ?? 'Recipe Import Bot';
const CATALOG_OWNER_EMAIL =
  process.env.RECIPE_IMPORT_OWNER_EMAIL ?? 'import-bot@example.com';
const CATALOG_OWNER_LEGACY_SUB =
  process.env.RECIPE_IMPORT_OWNER_LEGACY_SUB ??
  `legacy-${CATALOG_OWNER_USER_ID}`;
const CATALOG_HOUSEHOLD_ID =
  process.env.RECIPE_IMPORT_HOUSEHOLD_ID ??
  '22222222-2222-4222-8222-222222222222';
const CATALOG_HOUSEHOLD_NAME =
  process.env.RECIPE_IMPORT_HOUSEHOLD_NAME ?? 'Katalog Scoffie';

async function main() {
  // Ten sam strażnik, co przy przebudowie bazy: zapis wymaga dzisiejszej
  // daty UTC, a dla bazy spoza tej maszyny — jawnie podanego hosta.
  // Sama `RESET_ACCOUNTS_WRITE=true` zostawiona w Railway Variables robiła
  // z każdego kolejnego „pokaż raport" kasowanie produkcji.
  const decision = decideResetAccounts({
    env: process.env,
    argv: process.argv,
  });
  const shouldWrite = decision.allowed;
  console.log(`Baza: ${decision.host ?? '(nieznany host)'}`);
  if (decision.requested && !decision.allowed) {
    console.error(`\nSTOP: ${decision.reason}`);
    process.exitCode = 1;
    return;
  }

  const [userCount, householdCount, flaggedCatalog, legacyCatalog] =
    await Promise.all([
      prisma.user.count(),
      prisma.household.count(),
      prisma.recipe.count({ where: { isCatalog: true } }),
      prisma.recipe.count({
        where: { isCatalog: false, householdId: CATALOG_HOUSEHOLD_ID },
      }),
    ]);

  console.log('Stan przed:');
  console.log(`  użytkownicy:            ${userCount}`);
  console.log(`  gospodarstwa:           ${householdCount}`);
  console.log(`  przepisy isCatalog:     ${flaggedCatalog}`);
  console.log(
    `  przepisy katalogu bez flagi (stary schemat): ${legacyCatalog}`,
  );

  if (flaggedCatalog === 0 && legacyCatalog === 0) {
    // Bez tego bezpiecznika „reset" na bazie, na której katalog stoi pod
    // jeszcze innym id gospodarstwa, skasowałby cały katalog przepisów.
    console.error(
      '\nSTOP: nie znalazłem ani jednego przepisu katalogowego.\n' +
        'Sprawdź, gdzie leży katalog:\n' +
        '  SELECT "householdId", "isCatalog", count(*) FROM "Recipe" GROUP BY 1, 2;\n' +
        'i podaj właściwe id przez RECIPE_IMPORT_HOUSEHOLD_ID, zanim uruchomisz reset.',
    );
    process.exitCode = 1;
    return;
  }

  // Gdzie katalog mieszka teraz — czysto informacyjnie, żeby było widać,
  // czy w ogóle trzeba go przenosić.
  const catalogHomes = await prisma.recipe.groupBy({
    by: ['householdId'],
    where: catalogWhere(flaggedCatalog),
    _count: { _all: true },
  });
  console.log('\nKatalog leży w gospodarstwach:');
  for (const home of catalogHomes) {
    const household = await prisma.household.findUnique({
      where: { id: home.householdId },
      select: { name: true, _count: { select: { memberships: true } } },
    });
    console.log(
      `  ${home.householdId} | „${household?.name ?? '???'}” | ` +
        `przepisów: ${home._count._all} | domowników: ${household?._count.memberships ?? 0}`,
    );
  }
  console.log(`\nDocelowo katalog trafi do ${CATALOG_HOUSEHOLD_ID}.`);

  if (!shouldWrite) {
    console.log(
      `\nDRY-RUN. Do skasowania: ${userCount} użytkowników, ` +
        `${householdCount} gospodarstw (poza gospodarstwem katalogu).\n` +
        'Żeby wykonać: RESET_ACCOUNTS_WRITE=true (albo --write) ' +
        '+ RESET_ACCOUNTS_CONFIRM=<dzisiejsza data UTC> ' +
        '+ RESET_ACCOUNTS_ALLOW_HOST=<host z DATABASE_URL> dla bazy spoza tej maszyny.',
    );
    return;
  }

  await ensureCatalogContext();

  const moved = await prisma.recipe.updateMany({
    where: catalogWhere(flaggedCatalog),
    data: {
      householdId: CATALOG_HOUSEHOLD_ID,
      authorId: CATALOG_OWNER_USER_ID,
      isCatalog: true,
    },
  });
  console.log(`\nPrzeniesiono przepisów katalogu: ${moved.count}.`);

  // Kolejność ma znaczenie: użytkownicy najpierw, bo `Household.createdById`
  // to `SetNull`, a `Recipe.author` to `Cascade` — po przeniesieniu katalogu
  // kasowanie kont nie ma już czego z niego zabrać.
  const deletedUsers = await prisma.user.deleteMany({
    where: { id: { not: CATALOG_OWNER_USER_ID } },
  });
  const deletedHouseholds = await prisma.household.deleteMany({
    where: { id: { not: CATALOG_HOUSEHOLD_ID } },
  });
  console.log(`Usunięto użytkowników:  ${deletedUsers.count}`);
  console.log(`Usunięto gospodarstw:   ${deletedHouseholds.count}`);

  const scrubbed = await scrubCatalogHousehold();
  console.log(
    `Wyczyszczono w gospodarstwie katalogu: ${scrubbed} rekordów planów, ` +
      'list zakupów, archiwów, ulubionych, zaproszeń i rozmów asystenta.',
  );

  const [usersAfter, householdsAfter, recipesAfter] = await Promise.all([
    prisma.user.count(),
    prisma.household.count(),
    prisma.recipe.count({ where: { isCatalog: true } }),
  ]);
  console.log('\nStan po:');
  console.log(`  użytkownicy:        ${usersAfter} (bot importu)`);
  console.log(`  gospodarstwa:       ${householdsAfter} (katalog)`);
  console.log(`  przepisy katalogu:  ${recipesAfter}`);
}

/**
 * Które przepisy uznajemy za katalog.
 *
 * Na bazie po migracji do `isCatalog` decyduje flaga. Na bazie sprzed niej
 * flagi nie ma jeszcze na czym postawić, więc katalog rozpoznajemy po
 * gospodarstwie — dokładnie tak, jak robił to `findAll` przed wprowadzeniem
 * widoczności. Przeniesienie ustawia flagę, więc to jednorazowa ścieżka.
 */
function catalogWhere(flaggedCatalog: number): Prisma.RecipeWhereInput {
  return flaggedCatalog > 0
    ? { isCatalog: true }
    : { householdId: CATALOG_HOUSEHOLD_ID };
}

/** Bot importu + gospodarstwo katalogu. Ten sam kod, co w imporcie JSON. */
async function ensureCatalogContext() {
  const user = await prisma.user.upsert({
    where: { id: CATALOG_OWNER_USER_ID },
    update: {
      displayName: CATALOG_OWNER_DISPLAY_NAME,
      email: CATALOG_OWNER_EMAIL,
    },
    create: {
      id: CATALOG_OWNER_USER_ID,
      googleId: CATALOG_OWNER_LEGACY_SUB,
      displayName: CATALOG_OWNER_DISPLAY_NAME,
      email: CATALOG_OWNER_EMAIL,
    },
    select: { id: true },
  });

  await prisma.household.upsert({
    where: { id: CATALOG_HOUSEHOLD_ID },
    update: {},
    create: {
      id: CATALOG_HOUSEHOLD_ID,
      name: CATALOG_HOUSEHOLD_NAME,
      createdById: user.id,
    },
    select: { id: true },
  });

  await prisma.membership.upsert({
    where: {
      userId_householdId: {
        userId: CATALOG_OWNER_USER_ID,
        householdId: CATALOG_HOUSEHOLD_ID,
      },
    },
    update: { role: 'OWNER' },
    create: {
      userId: CATALOG_OWNER_USER_ID,
      householdId: CATALOG_HOUSEHOLD_ID,
      role: 'OWNER',
    },
  });
}

/**
 * Gospodarstwo katalogu przeżywa reset, więc jego własne dane trzeba
 * posprzątać ręcznie — inaczej zostałby w nim plan tygodnia i lista zakupów
 * po koncie, którego już nie ma. Przepisów NIE ruszamy: po to ten dom żyje.
 */
async function scrubCatalogHousehold(): Promise<number> {
  const where = { householdId: CATALOG_HOUSEHOLD_ID };
  const results = await prisma.$transaction([
    prisma.weeklyPlan.deleteMany({ where }),
    prisma.shoppingList.deleteMany({ where }),
    prisma.shoppingListArchive.deleteMany({ where }),
    prisma.shoppingListArchiveState.deleteMany({ where }),
    prisma.shoppingItemCheck.deleteMany({ where }),
    prisma.recipeFavorite.deleteMany({ where }),
    prisma.invitation.deleteMany({ where }),
    prisma.agentConversation.deleteMany({ where }),
    prisma.agentMemory.deleteMany({ where }),
    prisma.cookidooIntegration.deleteMany({ where }),
  ]);
  return results.reduce((sum, result) => sum + result.count, 0);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
