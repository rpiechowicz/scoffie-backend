import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException } from '../../common/app-exception';
import { PrismaService } from '../../prisma/prisma.service';
import { publishCookScenario } from '../../recipes/cook-scenario/cook-scenario.publish';
import { COOK_SCENARIO_RULES_VERSION } from '../../recipes/cook-scenario/cook-scenario.types';
import {
  checkScenarioAgainstRecipe,
  parseCookScenarioContent,
} from '../../recipes/cook-scenario/cook-scenario.validate';
import { qualityChecks } from '../../recipes/cook-scenario/writer/writer.checks';
import {
  readWriterRecipe,
  writerInputHash,
} from '../../recipes/cook-scenario/writer/writer.store';
import {
  AdminAuditService,
  type AdminActor,
} from '../audit/admin-audit.service';
import type {
  CookScenarioDetail,
  CookScenarioListData,
  CookScenarioListItem,
  CookScenarioState,
  CookScenarioVersionRow,
} from '../contract';
import { readOnlyQuery } from '../read-only-query';

const STATES: readonly CookScenarioState[] = [
  'PUBLISHED',
  'STALE',
  'VALIDATED',
  'REJECTED',
  'SKIPPED',
  'NONE',
];

type Row = {
  status: CookScenarioVersionRow['status'];
  version: number;
  publishedAt: Date | null;
};

/**
 * Stan przepisu z jego wierszy scenariusza (od najnowszej wersji) i
 * `Recipe.cookScenarioVersion`. Opublikowany wygrywa zawsze; inaczej mówi
 * najnowsza wersja (RETIRED/DRAFT bez następcy = nic dla telefonu).
 * `STALE` = był na telefonach i zniknął (opublikowany wiersz przeterminował
 * trigger albo PUBLISHED bez `cookScenarioVersion` — stan niespójny, do
 * ponownej publikacji). Wersja robocza oznaczona STALE przez system pisania
 * nigdy nie była opublikowana — to `VALIDATED` (treść do sprawdzenia).
 */
export function scenarioState(
  rows: readonly Row[],
  cookScenarioVersion: number | null,
): CookScenarioState {
  const published = rows.some((row) => row.status === 'PUBLISHED');
  if (published) return cookScenarioVersion !== null ? 'PUBLISHED' : 'STALE';
  const latest = rows[0];
  if (!latest) return 'NONE';
  if (latest.status === 'STALE') {
    return latest.publishedAt !== null ? 'STALE' : 'VALIDATED';
  }
  if (
    latest.status === 'VALIDATED' ||
    latest.status === 'REJECTED' ||
    latest.status === 'SKIPPED'
  ) {
    return latest.status;
  }
  return 'NONE';
}

async function recipeSignature(
  tx: Prisma.TransactionClient,
  recipeId: string,
): Promise<string> {
  const [{ signature }] = await tx.$queryRaw<{ signature: string }[]>`
    SELECT recipe_content_signature(${recipeId}::uuid) AS "signature"`;
  return signature;
}

const notFound = () =>
  new AppException(
    'RECIPE_NOT_FOUND',
    'Nie znaleziono przepisu.',
    HttpStatus.NOT_FOUND,
  );

/**
 * Scenariusze trybu Gotuj w panelu (E3c, docs iOS Gotuj §7.5): stan
 * katalogu, podgląd z walidatorami na BIEŻĄCYM przepisie, publikacja po
 * edycji (albo ponowna — po zmianie przepisu scenariusz dostaje STALE
 * i znika z telefonów) i wycofanie. Zapis idzie przez `publishCookScenario`
 * (blokada przepisu, wersje, delta katalogu), a przed nim przez te same
 * walidatory twarde co system pisania — człowiek nie omija reguł.
 */
@Injectable()
export class AdminCookScenariosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  list(): Promise<CookScenarioListData> {
    return readOnlyQuery(this.prisma, async (tx) => {
      const [recipes, rows] = await Promise.all([
        tx.recipe.findMany({
          where: { isCatalog: true },
          select: {
            id: true,
            title: true,
            mealType: true,
            isActive: true,
            cookScenarioVersion: true,
          },
          orderBy: [{ title: 'asc' }, { id: 'asc' }],
        }),
        tx.recipeCookScenario.findMany({
          where: { recipe: { isCatalog: true } },
          select: {
            recipeId: true,
            version: true,
            status: true,
            skipReason: true,
            updatedAt: true,
            publishedAt: true,
          },
          orderBy: [{ recipeId: 'asc' }, { version: 'desc' }],
        }),
      ]);
      const byRecipe = new Map<string, typeof rows>();
      for (const row of rows) {
        const list = byRecipe.get(row.recipeId) ?? [];
        list.push(row);
        byRecipe.set(row.recipeId, list);
      }
      const counts = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<
        CookScenarioState,
        number
      >;
      const items = recipes.map((recipe): CookScenarioListItem => {
        const own = byRecipe.get(recipe.id) ?? [];
        const state = scenarioState(own, recipe.cookScenarioVersion);
        counts[state] += 1;
        const latest = own[0];
        return {
          recipeId: recipe.id,
          title: recipe.title,
          mealType: recipe.mealType,
          isActive: recipe.isActive,
          state,
          publishedVersion:
            state === 'PUBLISHED' ? recipe.cookScenarioVersion : null,
          latestVersion: latest?.version ?? null,
          updatedAt: latest?.updatedAt.toISOString() ?? null,
          skipReason: latest?.status === 'SKIPPED' ? latest.skipReason : null,
        };
      });
      return { counts, items };
    });
  }

  detail(recipeId: string): Promise<CookScenarioDetail> {
    return readOnlyQuery(this.prisma, (tx) => this.readDetail(tx, recipeId));
  }

  /**
   * Publikacja treści z panelu — edytowanej albo bez zmian (ponowna po
   * STALE). Walidatory twarde systemu pisania (błędy = 400 z listą, nic się
   * nie zapisuje). Dwa tokeny ze szczegółu, sprawdzane pod blokadą przepisu
   * (409, panel odświeża): `basedOnVersion` = `latestVersion` (ktoś
   * opublikował albo system pisania dopisał wersję) i `recipeSignature` =
   * podpis przepisu (przepis zmienił się w międzyczasie — trigger STALE
   * numeru wersji nie podbija, recenzja 3.10). Wersja niesie `inputHash`
   * przepisu — system pisania uzna ją za aktualny wynik i nie napisze
   * przepisu drugi raz.
   */
  async publish(
    actor: AdminActor,
    recipeId: string,
    input: {
      content: unknown;
      basedOnVersion: number | null;
      recipeSignature: string;
    },
  ): Promise<CookScenarioDetail> {
    await this.audit.run(
      actor,
      {
        action: 'cook.scenario.publish',
        targetType: 'Recipe',
        targetId: recipeId,
        details: { basedOnVersion: input.basedOnVersion },
      },
      () =>
        this.prisma.$transaction(async (tx) => {
          await this.lockCatalogRecipe(tx, recipeId);
          const latest = await tx.recipeCookScenario.findFirst({
            where: { recipeId },
            orderBy: { version: 'desc' },
            select: { version: true },
          });
          const signature = await recipeSignature(tx, recipeId);
          if (
            (latest?.version ?? null) !== input.basedOnVersion ||
            signature !== input.recipeSignature
          ) {
            throw new AppException(
              'CONFLICT',
              'Scenariusz albo przepis zmienił się w międzyczasie — odśwież i nanieś zmiany jeszcze raz.',
              HttpStatus.CONFLICT,
              [`najnowsza wersja: ${latest?.version ?? 'brak'}`],
            );
          }
          const recipe = await readWriterRecipe(tx, recipeId);
          if (!recipe) throw notFound();
          const parsed = parseCookScenarioContent(input.content);
          if (!parsed.content) {
            throw new AppException(
              'VALIDATION_ERROR',
              'Scenariusz ma zły kształt.',
              HttpStatus.BAD_REQUEST,
              parsed.errors,
            );
          }
          const quality = qualityChecks(recipe, parsed.content);
          const errors = [
            ...checkScenarioAgainstRecipe(parsed.content, recipe),
            ...quality.errors,
          ];
          if (errors.length > 0) {
            throw new AppException(
              'VALIDATION_ERROR',
              'Scenariusz nie przechodzi walidacji.',
              HttpStatus.BAD_REQUEST,
              errors,
            );
          }
          return publishCookScenario(tx, {
            recipeId,
            content: parsed.content,
            rulesVersion: COOK_SCENARIO_RULES_VERSION,
            generator: {
              source: 'panel',
              basedOnVersion: input.basedOnVersion,
              by: actor.adminEmail,
            },
            validationReport: {
              outcome: 'VALIDATED',
              inputHash: writerInputHash(recipe),
              panel: {
                at: new Date().toISOString(),
                warnings: quality.warnings,
              },
            },
          });
        }),
      // Audyt mówi, co zapisano: nowa wersja albo nic (ta sama treść).
      (result) => ({ version: result.version, changed: result.changed }),
    );
    return this.detail(recipeId);
  }

  /**
   * Wycofanie opublikowanego scenariusza: wiersz REJECTED z powodem,
   * `Recipe.cookScenarioVersion` = null — telefony dostają deltę katalogu
   * i chowają „Gotuj”. Wiersze scenariuszy zmienia tylko ten, kto trzyma
   * blokadę przepisu.
   */
  async withdraw(
    actor: AdminActor,
    recipeId: string,
    reason: string,
  ): Promise<CookScenarioDetail> {
    await this.audit.run(
      actor,
      {
        action: 'cook.scenario.withdraw',
        targetType: 'Recipe',
        targetId: recipeId,
        details: { reason },
      },
      () =>
        this.prisma.$transaction(async (tx) => {
          await this.lockCatalogRecipe(tx, recipeId);
          const published = await tx.recipeCookScenario.findFirst({
            where: { recipeId, status: 'PUBLISHED' },
            select: { id: true, validationReport: true },
          });
          if (!published) {
            throw new AppException(
              'CONFLICT',
              'Ten przepis nie ma opublikowanego scenariusza.',
              HttpStatus.CONFLICT,
            );
          }
          const report =
            published.validationReport &&
            typeof published.validationReport === 'object' &&
            !Array.isArray(published.validationReport)
              ? published.validationReport
              : {};
          await tx.recipeCookScenario.update({
            where: { id: published.id },
            data: {
              status: 'REJECTED',
              validationReport: {
                ...report,
                withdrawn: {
                  at: new Date().toISOString(),
                  by: actor.adminEmail,
                  reason,
                },
              },
            },
          });
          await tx.recipe.update({
            where: { id: recipeId },
            data: { cookScenarioVersion: null },
          });
        }),
    );
    return this.detail(recipeId);
  }

  private async lockCatalogRecipe(
    tx: Prisma.TransactionClient,
    recipeId: string,
  ): Promise<void> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Recipe"
      WHERE "id" = ${recipeId}::uuid AND "isCatalog" = true
      FOR UPDATE`;
    if (locked.length === 0) throw notFound();
  }

  private async readDetail(
    tx: Prisma.TransactionClient,
    recipeId: string,
  ): Promise<CookScenarioDetail> {
    const head = await tx.recipe.findFirst({
      where: { id: recipeId, isCatalog: true },
      select: { isActive: true, cookScenarioVersion: true },
    });
    const recipe = head ? await readWriterRecipe(tx, recipeId) : null;
    if (!head || !recipe) throw notFound();
    const rows = await tx.recipeCookScenario.findMany({
      where: { recipeId },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        version: true,
        status: true,
        rulesVersion: true,
        content: true,
        skipReason: true,
        generator: true,
        validationReport: true,
        createdAt: true,
        publishedAt: true,
      },
    });
    const state = scenarioState(rows, head.cookScenarioVersion);
    const signature = await recipeSignature(tx, recipeId);
    const source =
      rows.find((row) => row.status === 'PUBLISHED' && state === 'PUBLISHED') ??
      rows.find((row) => row.content !== null);
    const parsed = source ? parseCookScenarioContent(source.content) : null;
    let checks: CookScenarioDetail['checks'] = null;
    if (parsed?.content) {
      const quality = qualityChecks(recipe, parsed.content);
      checks = {
        errors: [
          ...checkScenarioAgainstRecipe(parsed.content, recipe),
          ...quality.errors,
        ],
        warnings: quality.warnings,
      };
    } else if (parsed) {
      checks = { errors: parsed.errors, warnings: [] };
    }
    return {
      recipe: {
        id: recipe.id,
        title: recipe.title,
        servings: recipe.servings,
        isActive: head.isActive,
        instructions: recipe.instructions,
        ingredients: recipe.ingredients.map((row) => ({
          ingredientId: row.ingredientId,
          name: row.name,
          amount: row.amount,
          unit: row.unit,
        })),
      },
      state,
      publishedVersion: state === 'PUBLISHED' ? head.cookScenarioVersion : null,
      latestVersion: rows[0]?.version ?? null,
      recipeSignature: signature,
      skipReason: rows[0]?.status === 'SKIPPED' ? rows[0].skipReason : null,
      versions: rows.map((row) => {
        // System pisania i import trzymają ocenę w `review`; starsze — wyżej.
        const report = (row.validationReport ?? {}) as {
          score?: unknown;
          summary?: unknown;
          belowThreshold?: unknown;
          review?: { score?: unknown; summary?: unknown } | null;
        };
        const score = report.review?.score ?? report.score;
        const summary = report.review?.summary ?? report.summary;
        const generator = (row.generator ?? {}) as { source?: unknown };
        return {
          id: row.id,
          version: row.version,
          status: row.status,
          rulesVersion: row.rulesVersion,
          source:
            typeof generator.source === 'string' ? generator.source : null,
          createdAt: row.createdAt.toISOString(),
          publishedAt: row.publishedAt?.toISOString() ?? null,
          reviewScore: typeof score === 'number' ? score : null,
          reviewSummary: typeof summary === 'string' ? summary : null,
          belowThreshold: report.belowThreshold === true,
        };
      }),
      current:
        source && parsed?.content
          ? {
              version: source.version,
              status: source.status,
              content: parsed.content,
            }
          : null,
      checks,
    };
  }
}
