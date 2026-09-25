import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { CatalogExcludedIngredient, CatalogInsights } from '../contract';
import { readOnlyQuery } from '../read-only-query';
import {
  compareGapRecipes,
  countGaps,
  rank,
  recipeGaps,
  type GapInputRow,
} from './catalog-insights';

/** Okno rankingów „w planach”, „zjedzone”, „proponowane”. */
export const POPULARITY_DAYS = 30;
const TOP = 10;
const NEVER_USED_LIMIT = 50;
const EXCLUDED_LIMIT = 15;

type Count = { recipeId: string; count: number };

/**
 * „Jakość” i „Popularność” katalogu (ROADMAPA §5.7) — WYŁĄCZNIE wspólny
 * katalog (`isCatalog = true`), jak reszta ekranu. Preferencje („czego nie
 * jem”) wychodzą wyłącznie jako liczba osób na składnik.
 */
@Injectable()
export class AdminCatalogInsightsService {
  constructor(private readonly prisma: PrismaService) {}

  insights(now: Date = new Date()): Promise<CatalogInsights> {
    const since = new Date(now.getTime() - POPULARITY_DAYS * 86_400_000);
    return readOnlyQuery(this.prisma, async (tx) => {
      const rows: GapInputRow[] = await tx.recipe.findMany({
        where: { isCatalog: true },
        select: {
          id: true,
          title: true,
          imageUrl: true,
          isActive: true,
          mealType: true,
          suitableMealTypes: true,
          nutritionKcal: true,
          nutritionProtein: true,
          nutritionFat: true,
          nutritionCarbs: true,
          nutritionFiber: true,
          sourceInstructions: true,
          ingredients: {
            select: {
              normalizedUnit: true,
              ingredient: {
                select: {
                  name: true,
                  nutritionKcalPer100: true,
                  nutritionProteinPer100: true,
                  nutritionCarbsPer100: true,
                  nutritionFatPer100: true,
                  gramsPerPiece: true,
                },
              },
            },
          },
        },
      });
      const gapRecipes = rows
        .map(recipeGaps)
        .filter((row) => row !== null)
        .sort(compareGapRecipes);
      const meta = new Map(
        rows.map((row) => [
          row.id,
          { title: row.title, imageUrl: row.imageUrl, isActive: row.isActive },
        ]),
      );

      const planned = await tx.$queryRaw<Count[]>`
        SELECT pi."recipeId"::text AS "recipeId", COUNT(*)::int AS count
        FROM "PlanItem" pi
        JOIN "Recipe" r ON r.id = pi."recipeId" AND r."isCatalog" = true
        WHERE pi."createdAt" >= ${since}
        GROUP BY pi."recipeId"
        ORDER BY count DESC
        LIMIT ${TOP}`;

      const eaten = await tx.$queryRaw<Count[]>`
        SELECT pi."recipeId"::text AS "recipeId", COUNT(*)::int AS count
        FROM "PlanItemConsumption" c
        JOIN "PlanItem" pi ON pi.id = c."planItemId"
        JOIN "Recipe" r ON r.id = pi."recipeId" AND r."isCatalog" = true
        WHERE c."eatenAt" >= ${since}
        GROUP BY pi."recipeId"
        ORDER BY count DESC
        LIMIT ${TOP}`;

      const favorites = await tx.$queryRaw<Count[]>`
        SELECT f."recipeId"::text AS "recipeId", COUNT(*)::int AS count
        FROM "RecipeFavorite" f
        JOIN "Recipe" r ON r.id = f."recipeId" AND r."isCatalog" = true
        GROUP BY f."recipeId"
        ORDER BY count DESC
        LIMIT ${TOP}`;

      // Nowe dania w kartach propozycji. `action.slots` to STAN DOCELOWY
      // tygodnia (także dania, które już tam stały), więc liczymy z karty:
      // sloty `change = NEW` (PLAN_WEEK, PLAN_DAY) i `to` podmiany (SWAP).
      // HOUSEHOLD_SPLIT nie ma w karcie id przepisu — pomijamy.
      const proposed = await tx.$queryRaw<Count[]>`
        WITH picks AS (
          SELECT p.id, s->>'recipeId' AS rid
          FROM "AgentProposal" p
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(p.card->'days') = 'array' THEN p.card->'days' ELSE '[]'::jsonb END
          ) d
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(d->'slots') = 'array' THEN d->'slots' ELSE '[]'::jsonb END
          ) s
          WHERE p.kind = 'PLAN_WEEK' AND p."createdAt" >= ${since} AND s->>'change' = 'NEW'
          UNION ALL
          SELECT p.id, s->>'recipeId'
          FROM "AgentProposal" p
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(p.card->'slots') = 'array' THEN p.card->'slots' ELSE '[]'::jsonb END
          ) s
          WHERE p.kind = 'PLAN_DAY' AND p."createdAt" >= ${since} AND s->>'change' = 'NEW'
          UNION ALL
          SELECT p.id, p.card->'to'->>'recipeId'
          FROM "AgentProposal" p
          WHERE p.kind = 'SWAP' AND p."createdAt" >= ${since}
        )
        SELECT r.id::text AS "recipeId", COUNT(DISTINCT picks.id)::int AS count
        FROM picks
        JOIN "Recipe" r ON r.id::text = picks.rid AND r."isCatalog" = true
        GROUP BY r.id
        ORDER BY count DESC
        LIMIT ${TOP}`;

      const never = await tx.$queryRaw<{ recipeId: string }[]>`
        SELECT r.id::text AS "recipeId"
        FROM "Recipe" r
        WHERE r."isCatalog" = true AND r."isActive" = true
          AND NOT EXISTS (SELECT 1 FROM "PlanItem" pi WHERE pi."recipeId" = r.id)`;

      const excluded = await tx.$queryRaw<CatalogExcludedIngredient[]>(
        Prisma.sql`
          SELECT i."normalizedName" AS key, i.name, COUNT(*)::int AS count
          FROM "UserPreference" up
          CROSS JOIN LATERAL unnest(up."excludedIngredientIds") AS x(id)
          JOIN "Ingredient" i ON i.id::text = x.id
          GROUP BY i.id, i."normalizedName", i.name
          ORDER BY count DESC, i.name ASC
          LIMIT ${EXCLUDED_LIMIT}`,
      );

      const neverUsed = rank(
        never.map((row) => ({ recipeId: row.recipeId, count: 0 })),
        meta,
        Number.MAX_SAFE_INTEGER,
        { keepZero: true },
      );

      return {
        gaps: countGaps(gapRecipes),
        recipes: gapRecipes,
        popularity: {
          days: POPULARITY_DAYS,
          planned: rank(planned, meta, TOP),
          eaten: rank(eaten, meta, TOP),
          favorites: rank(favorites, meta, TOP),
          proposed: rank(proposed, meta, TOP),
          neverUsed: neverUsed.slice(0, NEVER_USED_LIMIT),
          neverUsedTotal: neverUsed.length,
          excludedIngredients: excluded,
        },
        generatedAt: now.toISOString(),
      };
    });
  }
}
