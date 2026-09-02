import { Prisma } from '@prisma/client';

/**
 * Konto techniczne katalogu („Recipe Import Bot") i jego gospodarstwo.
 *
 * Te same identyfikatory, których używa import katalogu
 * (`scripts/import-recipes-from-json.ts`) i reset kont
 * (`scripts/reset-accounts.ts`) — z tych samych zmiennych, z tymi samymi
 * wartościami domyślnymi. Do tej pory znały je wyłącznie skrypty; aplikacja
 * potrzebuje ich od chwili, gdy kasowanie konta przepina autorstwo przepisów
 * na bota zamiast kasować je kaskadą razem z planami innych domowników.
 */
export const DEFAULT_CATALOG_OWNER_USER_ID =
  '11111111-1111-4111-8111-111111111111';
export const DEFAULT_CATALOG_HOUSEHOLD_ID =
  '22222222-2222-4222-8222-222222222222';

export function catalogOwnerUserId(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    (env.RECIPE_IMPORT_OWNER_USER_ID ?? '').trim() ||
    DEFAULT_CATALOG_OWNER_USER_ID
  );
}

export function catalogHouseholdId(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    (env.RECIPE_IMPORT_HOUSEHOLD_ID ?? '').trim() ||
    DEFAULT_CATALOG_HOUSEHOLD_ID
  );
}

/**
 * Upewnia się, że konto bota istnieje, i oddaje jego id.
 *
 * Na produkcji bot jest od pierwszego importu. Na świeżej bazie dev albo w
 * CI może go nie być — a przepisu nie da się przepiąć na autora, którego nie
 * ma (klucz obcy). Upsert z tymi samymi polami co w skryptach: `googleId`
 * jako „legacy sub", bo `authProvider` domyślnie to GOOGLE i tak bot był
 * zakładany od początku.
 */
export async function ensureCatalogOwner(
  tx: Prisma.TransactionClient,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const id = catalogOwnerUserId(env);
  await tx.user.upsert({
    where: { id },
    update: {},
    create: {
      id,
      googleId:
        (env.RECIPE_IMPORT_OWNER_LEGACY_SUB ?? '').trim() || `legacy-${id}`,
      displayName:
        (env.RECIPE_IMPORT_OWNER_DISPLAY_NAME ?? '').trim() ||
        'Recipe Import Bot',
      email:
        (env.RECIPE_IMPORT_OWNER_EMAIL ?? '').trim() ||
        'recipe-import-bot@example.com',
    },
    select: { id: true },
  });
  return id;
}
