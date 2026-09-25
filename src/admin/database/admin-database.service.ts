import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { DatabaseData, DatabaseSlowQuery } from '../contract';
import { readOnlyQuery } from '../read-only-query';
import {
  LONG_QUERY_SECONDS,
  rowsEstimate,
  toNumber,
  toSlowQuery,
} from './database-stats';

/**
 * Stan bazy dla „Systemu” (ROADMAPA §5.10) — widoki systemowe Postgresa,
 * tylko odczyt. Z `pg_stat_activity` wychodzą WYŁĄCZNIE stany i czasy:
 * tekst bieżącego zapytania może zawierać dane osób (parametry wstawione
 * wprost), więc nie czytamy nawet kolumny `query`. Teksty z
 * `pg_stat_statements` są znormalizowane (`$1`) — idą przycięte.
 */
@Injectable()
export class AdminDatabaseService {
  private readonly logger = new Logger(AdminDatabaseService.name);

  constructor(private readonly prisma: PrismaService) {}

  async database(now: Date = new Date()): Promise<DatabaseData> {
    const base = await readOnlyQuery(this.prisma, async (tx) => {
      const [size] = await tx.$queryRaw<{ bytes: unknown }[]>`
        SELECT pg_database_size(current_database()) AS bytes`;

      const tables = await tx.$queryRaw<
        { name: string; bytes: unknown; rows: unknown }[]
      >`
        SELECT c.relname AS name,
               pg_total_relation_size(c.oid) AS bytes,
               c.reltuples AS rows
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_toast%'
        ORDER BY pg_total_relation_size(c.oid) DESC
        LIMIT 10`;

      const connections = await tx.$queryRaw<
        { state: string | null; count: unknown }[]
      >`
        SELECT state, COUNT(*) AS count
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND backend_type = 'client backend'
        GROUP BY state
        ORDER BY COUNT(*) DESC`;

      const [max] = await tx.$queryRaw<{ value: string | null }[]>`
        SELECT current_setting('max_connections', true) AS value`;

      // Bez kolumny `query` — patrz komentarz klasy.
      const long = await tx.$queryRaw<
        { seconds: unknown; state: string | null; wait: string | null }[]
      >`
        SELECT EXTRACT(EPOCH FROM (now() - query_start)) AS seconds,
               state,
               wait_event_type AS wait
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND backend_type = 'client backend'
          AND pid <> pg_backend_pid()
          AND state IS NOT NULL
          AND state <> 'idle'
          AND query_start < now() - ${LONG_QUERY_SECONDS} * interval '1 second'
        ORDER BY query_start ASC
        LIMIT 20`;

      const [migrationsTable] = await tx.$queryRaw<{ present: boolean }[]>`
        SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS present`;
      let migrations: DatabaseData['migrations'] = {
        last: null,
        applied: 0,
        failed: [],
      };
      if (migrationsTable?.present) {
        const [last] = await tx.$queryRaw<
          { name: string; finishedAt: Date | null }[]
        >`
          SELECT migration_name AS name, finished_at AS "finishedAt"
          FROM "_prisma_migrations"
          WHERE rolled_back_at IS NULL AND finished_at IS NOT NULL
          ORDER BY finished_at DESC, migration_name DESC
          LIMIT 1`;
        const [applied] = await tx.$queryRaw<{ count: unknown }[]>`
          SELECT COUNT(*) AS count FROM "_prisma_migrations"
          WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
        const failed = await tx.$queryRaw<{ name: string }[]>`
          SELECT migration_name AS name FROM "_prisma_migrations"
          WHERE finished_at IS NULL AND rolled_back_at IS NULL
          ORDER BY started_at ASC`;
        migrations = {
          last: last
            ? {
                name: last.name,
                finishedAt: last.finishedAt?.toISOString() ?? null,
              }
            : null,
          applied: toNumber(applied?.count),
          failed: failed.map((row) => row.name),
        };
      }

      const [extension] = await tx.$queryRaw<{ present: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
        ) AS present`;

      const maxConnections = toNumber(max?.value);
      return {
        sizeBytes: toNumber(size?.bytes),
        tables: tables.map((row) => ({
          name: row.name,
          totalBytes: toNumber(row.bytes),
          rowsEstimate: rowsEstimate(row.rows),
        })),
        connections: connections.map((row) => ({
          state: row.state ?? 'unknown',
          count: toNumber(row.count),
        })),
        maxConnections: maxConnections > 0 ? maxConnections : null,
        longQueries: long.map((row) => ({
          seconds: Math.round(toNumber(row.seconds)),
          state: row.state ?? 'unknown',
          waitEventType: row.wait,
        })),
        migrations,
        statementsEnabled: extension?.present === true,
      };
    });

    const { statementsEnabled, ...rest } = base;
    return {
      ...rest,
      slowQueries: statementsEnabled ? await this.slowQueries() : null,
      fetchedAt: now.toISOString(),
    };
  }

  /**
   * Osobna transakcja: rozszerzenie bywa utworzone bez
   * `shared_preload_libraries` — wtedy odczyt widoku rzuca, a błąd w środku
   * transakcji unieważniłby resztę odczytów. Porażka = `null` (jak „wyłączone”).
   */
  private async slowQueries(): Promise<DatabaseSlowQuery[] | null> {
    try {
      const rows = await readOnlyQuery(
        this.prisma,
        (tx) => tx.$queryRaw<
          {
            query: unknown;
            calls: unknown;
            meanMs: unknown;
            totalMs: unknown;
          }[]
        >`
          SELECT s.query,
                 s.calls,
                 s.mean_exec_time AS "meanMs",
                 s.total_exec_time AS "totalMs"
          FROM pg_stat_statements s
          WHERE s.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
            -- Tylko DML: ten jest znormalizowany ($1). Polecenia narzędziowe
            -- (DDL, SET, ALTER ROLE … PASSWORD) trafiają do widoku z literałami.
            AND lower(ltrim(s.query, ' ' || chr(9) || chr(10) || chr(13)))
                ~ '^(select|insert|update|delete|with)[^a-z_]'
          ORDER BY s.total_exec_time DESC
          LIMIT 10`,
      );
      return rows.map(toSlowQuery);
    } catch (error) {
      this.logger.warn(
        `pg_stat_statements niedostępne: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
      );
      return null;
    }
  }
}
