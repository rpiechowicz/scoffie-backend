import { Prisma } from '@prisma/client';
import { sqlInstant, warsawWeekStart } from './warsaw-calendar';

/**
 * JEDNA definicja „w planach” (`RecipeListItem.inPlans`) dla katalogu, karty
 * przepisu, wycofania i wyszukiwarki ⌘K — wcześniej katalog liczył pozycje,
 * a ⌘K plany, więc ten sam przepis miał dwie różne liczby.
 *
 * „W planach” = w ilu PLANACH TYGODNIA (`WeeklyPlan`) od BIEŻĄCEGO
 * poniedziałku (czas polski) wzwyż stoi przepis. Plany, nie pozycje: front
 * pisze „stoi teraz w N planach — tam zostanie”, a kontrakt „w ilu planach
 * stoi teraz”; ten sam przepis trzy razy w jednym tygodniu to jeden plan,
 * który wycofanie dotyka. Minione tygodnie to historia, której wycofanie już
 * nie dotyczy.
 *
 * Tylko przepisy katalogu — prywatnych panel nie liczy (ROADMAPA §5.7).
 * `recipeIds = null` = cały katalog (jedno zapytanie na listę, bez N+1).
 */
export async function inPlansByRecipe(
  tx: Prisma.TransactionClient,
  now: Date,
  recipeIds: readonly string[] | null,
): Promise<Map<string, number>> {
  if (recipeIds !== null && recipeIds.length === 0) return new Map();
  const onlyThese =
    recipeIds === null
      ? Prisma.empty
      : Prisma.sql`AND pi."recipeId" IN (${Prisma.join(
          recipeIds.map((id) => Prisma.sql`${id}::uuid`),
        )})`;
  const rows = await tx.$queryRaw<{ recipeId: string; inPlans: number }[]>`
    SELECT pi."recipeId", COUNT(DISTINCT pi."weeklyPlanId")::int AS "inPlans"
    FROM "PlanItem" pi
    JOIN "WeeklyPlan" wp ON wp."id" = pi."weeklyPlanId"
    JOIN "Recipe" r ON r."id" = pi."recipeId"
    WHERE r."isCatalog" = true
      AND wp."weekStart" >= ${sqlInstant(warsawWeekStart(now))}
      ${onlyThese}
    GROUP BY pi."recipeId"`;
  return new Map(rows.map((row) => [row.recipeId, row.inPlans]));
}
