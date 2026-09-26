import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import {
  RecipeListItem,
  recipeListSelect,
  RecipesService,
} from './recipes.service';

/**
 * Synchronizacja PUBLICZNEGO katalogu z telefonem (workstream, Etap 4A).
 *
 * Źródłem prawdy jest trwały log `CatalogChange` wypełniany triggerami bazy
 * (każda ścieżka zapisu katalogu przesuwa rewizję — panel, import, loader
 * tagów, skrypty). Dwie ścieżki:
 *
 * - SNAPSHOT — cały aktywny katalog stronami po `id`, z rewizją-znacznikiem
 *   (high-watermark) USTALONĄ na pierwszej stronie i odsyłaną przez klienta
 *   na kolejnych. Strony czytają stan bieżący; wszystko, co zmieniło się po
 *   znaczniku, przyjdzie w następnej delcie (upsert jest idempotentny,
 *   tombstone usuwa także rekord, którego klient nie miał) — snapshot
 *   w znaczniku R + delta od R daje stan spójny.
 * - DELTA — przepisy zmienione w (since, until] jako upserty (stan bieżący)
 *   i tombstone'y (wycofane, usunięte, wyjęte z katalogu), stronami po
 *   `recipeId`, z `until` ustalonym na pierwszej stronie.
 *
 * Rewizja dla klienta to NIEPRZEZROCZYSTY token `<epoka>.<numer>`. Nieznana
 * epoka (odtworzona baza), numer poniżej `minRevision` (wyczyszczona
 * historia) albo z przyszłości = `RESET_REQUIRED` — klient robi snapshot,
 * zamiast dostać deltę, która udaje kompletność.
 *
 * Przepisy gospodarstw i ulubione nie wchodzą ani do snapshotu, ani do delty
 * — telefon dostaje je osobno (`recipes:householdState`).
 */
export const CATALOG_SYNC_DEFAULT_LIMIT = 200;
export const CATALOG_SYNC_MAX_LIMIT = 500;

export type CatalogItem = RecipeListItem;

export type CatalogSnapshotPage =
  | {
      mode: 'SNAPSHOT';
      /** Znacznik snapshotu — ten sam na każdej stronie jednego przebiegu. */
      revision: string;
      items: CatalogItem[];
      /** `null` = ostatnia strona. */
      nextCursor: string | null;
    }
  | CatalogResetRequired;

export type CatalogChangesPage =
  | {
      mode: 'DELTA';
      fromRevision: string;
      /** Rewizja, do której klient jest po zastosowaniu WSZYSTKICH stron. */
      revision: string;
      upserts: CatalogItem[];
      /** Identyfikatory przepisów, które klient ma usunąć (albo ukryć). */
      tombstones: string[];
      nextCursor: string | null;
    }
  | CatalogResetRequired;

export type CatalogResetRequired = {
  mode: 'RESET_REQUIRED';
  snapshotRequired: true;
  /** Aktualna rewizja — informacyjnie; klient zaczyna snapshot od zera. */
  revision: string;
  reason: 'UNKNOWN_REVISION' | 'REVISION_PRUNED' | 'FUTURE_REVISION';
};

type SyncHead = { epoch: string; head: bigint; minRevision: bigint };
type ParsedRevision = { epoch: string; revision: bigint };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function formatCatalogRevision(epoch: string, revision: bigint): string {
  return `${epoch}.${revision.toString()}`;
}

export function parseCatalogRevision(token: unknown): ParsedRevision | null {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const epoch = token.slice(0, dot);
  const number = token.slice(dot + 1);
  if (!UUID_RE.test(epoch) || !/^\d{1,19}$/.test(number)) return null;
  return { epoch: epoch.toLowerCase(), revision: BigInt(number) };
}

function limitOf(value: unknown): number {
  const number =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.round(value)
      : CATALOG_SYNC_DEFAULT_LIMIT;
  return Math.min(CATALOG_SYNC_MAX_LIMIT, Math.max(1, number));
}

function cursorOf(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new AppException(
      'VALIDATION_ERROR',
      'cursor: identyfikator z poprzedniej strony (nextCursor).',
      HttpStatus.BAD_REQUEST,
      ['cursor'],
    );
  }
  return value.toLowerCase();
}

@Injectable()
export class CatalogSyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly recipes: RecipesService,
  ) {}

  /** Bieżąca rewizja katalogu (token) — np. do nagłówka stanu. */
  async currentRevision(): Promise<string> {
    const head = await this.head();
    return formatCatalogRevision(head.epoch, head.head);
  }

  async snapshot(input: {
    revision?: string;
    cursor?: string;
    limit?: number;
  }): Promise<CatalogSnapshotPage> {
    const head = await this.head();
    let pinned = head.head;
    if (input.revision !== undefined) {
      // Kolejna strona tego samego przebiegu: znacznik z pierwszej strony.
      const parsed = parseCatalogRevision(input.revision);
      const problem = this.problemOf(parsed, head, { allowHead: true });
      if (problem || !parsed)
        return this.reset(head, problem ?? 'UNKNOWN_REVISION');
      pinned = parsed.revision;
    }
    const cursor = cursorOf(input.cursor);
    const limit = limitOf(input.limit);
    const rows = await this.prisma.recipe.findMany({
      where: {
        isCatalog: true,
        isActive: true,
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
      select: recipeListSelect,
    });
    const page = rows.slice(0, limit);
    return {
      mode: 'SNAPSHOT',
      revision: formatCatalogRevision(head.epoch, pinned),
      items: page.map((row) => this.recipes.toListItem(row)),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  async changes(input: {
    sinceRevision: string;
    untilRevision?: string;
    cursor?: string;
    limit?: number;
  }): Promise<CatalogChangesPage> {
    const head = await this.head();
    const since = parseCatalogRevision(input.sinceRevision);
    const sinceProblem = this.problemOf(since, head, { allowHead: true });
    if (sinceProblem || !since) {
      return this.reset(head, sinceProblem ?? 'UNKNOWN_REVISION');
    }
    let until = head.head;
    if (input.untilRevision !== undefined) {
      const parsed = parseCatalogRevision(input.untilRevision);
      const problem = this.problemOf(parsed, head, { allowHead: true });
      if (problem || !parsed || parsed.revision < since.revision) {
        return this.reset(head, problem ?? 'UNKNOWN_REVISION');
      }
      until = parsed.revision;
    }
    const cursor = cursorOf(input.cursor);
    const limit = limitOf(input.limit);
    const base = {
      mode: 'DELTA' as const,
      fromRevision: formatCatalogRevision(head.epoch, since.revision),
      revision: formatCatalogRevision(head.epoch, until),
    };
    if (until === since.revision) {
      return { ...base, upserts: [], tombstones: [], nextCursor: null };
    }
    // Każdy przepis raz, niezależnie od liczby wpisów w logu (import zmienia
    // przepis i dziesięć jego składników = jedenaście wpisów).
    const changed = await this.prisma.$queryRaw<{ recipeId: string }[]>(
      Prisma.sql`
        SELECT DISTINCT "recipeId"
        FROM "CatalogChange"
        WHERE "revision" > ${since.revision} AND "revision" <= ${until}
        ${cursor ? Prisma.sql`AND "recipeId" > ${cursor}::uuid` : Prisma.empty}
        ORDER BY "recipeId"
        LIMIT ${limit + 1}
      `,
    );
    const ids = changed.slice(0, limit).map((row) => row.recipeId);
    const rows =
      ids.length === 0
        ? []
        : await this.prisma.recipe.findMany({
            where: { id: { in: ids } },
            select: { ...recipeListSelect, isCatalog: true },
          });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const upserts: CatalogItem[] = [];
    const tombstones: string[] = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (row && row.isCatalog && row.isActive) {
        const { isCatalog: _isCatalog, ...listRow } = row;
        upserts.push(this.recipes.toListItem(listRow));
      } else {
        tombstones.push(id);
      }
    }
    return {
      ...base,
      upserts,
      tombstones,
      nextCursor: changed.length > limit ? ids[ids.length - 1] : null,
    };
  }

  private async head(): Promise<SyncHead> {
    const [row] = await this.prisma.$queryRaw<
      { epoch: string; minRevision: bigint; head: bigint }[]
    >(Prisma.sql`
      SELECT s."epoch"::text AS "epoch",
             s."minRevision" AS "minRevision",
             COALESCE((SELECT MAX("revision") FROM "CatalogChange"), 0)::bigint AS "head"
      FROM "CatalogSyncState" s
      WHERE s."id" = 1
    `);
    if (!row) {
      throw new AppException(
        'SERVICE_UNAVAILABLE',
        'Synchronizacja katalogu nie jest gotowa (brak stanu logu).',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return {
      epoch: row.epoch.toLowerCase(),
      head: BigInt(row.head),
      minRevision: BigInt(row.minRevision),
    };
  }

  private problemOf(
    parsed: ParsedRevision | null,
    head: SyncHead,
    options: { allowHead: boolean },
  ): CatalogResetRequired['reason'] | null {
    if (!parsed || parsed.epoch !== head.epoch) return 'UNKNOWN_REVISION';
    if (parsed.revision < head.minRevision) return 'REVISION_PRUNED';
    if (
      parsed.revision > head.head ||
      (!options.allowHead && parsed.revision === head.head)
    ) {
      return 'FUTURE_REVISION';
    }
    return null;
  }

  private reset(
    head: SyncHead,
    reason: CatalogResetRequired['reason'],
  ): CatalogResetRequired {
    return {
      mode: 'RESET_REQUIRED',
      snapshotRequired: true,
      revision: formatCatalogRevision(head.epoch, head.head),
      reason,
    };
  }
}
