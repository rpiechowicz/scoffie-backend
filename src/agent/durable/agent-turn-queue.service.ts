import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LeaseLostError } from './turn-lease-config';

/** Tura przejęta przez workera — tożsamość lease i to, czego potrzebuje runner. */
export type ClaimedTurn = {
  turnId: string;
  leaseToken: string;
  attempt: number;
  /** Poprzedni właściciel (przy odzyskaniu) — do logu, bez treści. */
  previousOwner: string | null;
};

export type LeaseState = {
  /** Lease nadal należy do tego tokenu, a tura jest RUNNING. */
  held: boolean;
  cancelRequested: boolean;
};

/**
 * Kolejka tur na Postgresie (workstream, Etap 5) — bez Redis i bez osobnej
 * usługi. Zadaniem jest sam wiersz `AgentTurn`: RUNNING bez żywego lease =
 * gotowy do wykonania.
 *
 * Wszystkie terminy liczy ZEGAR BAZY (`now()`), nie procesu: dwie instancje
 * z rozjechanym zegarem nie mogą się różnić w tym, czy lease wygasł.
 */
@Injectable()
export class AgentTurnQueue {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Atomowe przejęcie tur: jedno zdanie `UPDATE … WHERE id IN (SELECT … FOR
   * UPDATE SKIP LOCKED)`. Dwóch workerów nie przejmie tej samej tury:
   * wiersz zablokowany przez jednego drugi pomija, a wiersz już przejęty
   * (commit przed naszym zablokowaniem) nie przechodzi ponownie warunku
   * `leaseExpiresAt < now()` — Postgres sprawdza go na najnowszej wersji.
   * Przejęcie daje NOWY token (fencing) i podbija `attempt`.
   *
   * Tylko tury: RUNNING, z zapisanym wejściem (`execution`), przed terminem,
   * bez „Stop", z wolnym albo wygasłym lease i z próbami poniżej limitu.
   */
  async claim(params: {
    workerId: string;
    leaseMs: number;
    maxAttempts: number;
    limit: number;
    turnId?: string;
  }): Promise<ClaimedTurn[]> {
    if (params.limit <= 0) return [];
    const only = params.turnId
      ? Prisma.sql`AND t."id" = ${params.turnId}::uuid`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        leaseToken: string;
        attempt: number;
        previousOwner: string | null;
      }[]
    >(Prisma.sql`
      WITH picked AS (
        SELECT t."id", t."leaseOwner" AS "previousOwner"
        FROM "AgentTurn" t
        WHERE t."status" = 'RUNNING'
          AND t."execution" IS NOT NULL
          AND t."cancelRequestedAt" IS NULL
          AND t."deadlineAt" > now()
          AND t."attempt" < ${params.maxAttempts}
          AND (t."leaseExpiresAt" IS NULL OR t."leaseExpiresAt" < now())
          ${only}
        ORDER BY t."startedAt"
        LIMIT ${params.limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "AgentTurn" a
         SET "leaseOwner" = ${params.workerId},
             "leaseToken" = gen_random_uuid(),
             "leaseExpiresAt" = now() + (${params.leaseMs} * interval '1 millisecond'),
             "attempt" = a."attempt" + 1,
             "updatedAt" = now()
        FROM picked
       WHERE a."id" = picked."id"
      RETURNING a."id", a."leaseToken"::text AS "leaseToken", a."attempt", picked."previousOwner"
    `);
    return rows.map((row) => ({
      turnId: row.id,
      leaseToken: row.leaseToken,
      attempt: Number(row.attempt),
      previousOwner: row.previousOwner,
    }));
  }

  /**
   * Odnowienie lease (co ⅓ ważności). Oddaje też trwały „Stop" — worker
   * przerywa lokalne wywołanie modelu. `held: false` = lease stracony
   * (przejęty albo tura domknięta) — worker przestaje pracować i niczego
   * już nie zapisuje.
   */
  async renew(
    turnId: string,
    leaseToken: string,
    leaseMs: number,
  ): Promise<LeaseState> {
    const rows = await this.prisma.$queryRaw<
      { cancelRequested: boolean }[]
    >(Prisma.sql`
      UPDATE "AgentTurn"
         SET "leaseExpiresAt" = now() + (${leaseMs} * interval '1 millisecond'),
             "updatedAt" = now()
       WHERE "id" = ${turnId}::uuid
         AND "leaseToken" = ${leaseToken}::uuid
         AND "status" = 'RUNNING'
      RETURNING ("cancelRequestedAt" IS NOT NULL) AS "cancelRequested"
    `);
    if (rows.length === 0) return { held: false, cancelRequested: false };
    return { held: true, cancelRequested: Boolean(rows[0].cancelRequested) };
  }

  /** Odczyt bez odnawiania — przed wywołaniem modelu i przed zapisem narzędzia. */
  async check(turnId: string, leaseToken: string): Promise<LeaseState> {
    const row = await this.prisma.agentTurn.findUnique({
      where: { id: turnId },
      select: { status: true, leaseToken: true, cancelRequestedAt: true },
    });
    if (!row || row.status !== 'RUNNING' || row.leaseToken !== leaseToken) {
      return { held: false, cancelRequested: false };
    }
    return { held: true, cancelRequested: row.cancelRequestedAt !== null };
  }

  /**
   * Oddanie tury bez domykania (łagodne zamknięcie procesu): lease wolny od
   * razu, więc nowa instancja przejmuje turę bez czekania na wygaśnięcie.
   */
  async release(turnId: string, leaseToken: string): Promise<boolean> {
    const released = await this.prisma.agentTurn.updateMany({
      where: { id: turnId, leaseToken, status: 'RUNNING' },
      data: { leaseOwner: null, leaseToken: null, leaseExpiresAt: null },
    });
    return released.count > 0;
  }

  /**
   * FENCING w transakcji efektu: blokuje wiersz tury i sprawdza, że lease
   * nadal należy do tego tokenu. Równoległe przejęcie czeka na nasz commit
   * (a potem widzi efekt w dzienniku) albo wygrało wcześniej — wtedy tu
   * `LeaseLostError` i cały efekt się wycofuje.
   */
  static async fence(
    tx: Prisma.TransactionClient,
    turnId: string,
    leaseToken: string,
  ): Promise<void> {
    const locked = await tx.$executeRaw(Prisma.sql`
      UPDATE "AgentTurn"
         SET "leaseToken" = "leaseToken"
       WHERE "id" = ${turnId}::uuid
         AND "leaseToken" = ${leaseToken}::uuid
         AND "status" = 'RUNNING'
    `);
    if (locked === 0) throw new LeaseLostError(turnId);
  }

  /** Stan kolejki do metryk: gotowe (bez żywego lease) i przejęte. */
  async gauges(
    maxAttempts: number,
  ): Promise<{ ready: number; claimed: number }> {
    const [row] = await this.prisma.$queryRaw<
      { ready: bigint; claimed: bigint }[]
    >(Prisma.sql`
      SELECT
        COUNT(*) FILTER (
          WHERE ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now())
            AND "cancelRequestedAt" IS NULL
            AND "deadlineAt" > now()
            AND "attempt" < ${maxAttempts}
        ) AS "ready",
        COUNT(*) FILTER (WHERE "leaseExpiresAt" >= now()) AS "claimed"
      FROM "AgentTurn"
      WHERE "status" = 'RUNNING' AND "execution" IS NOT NULL
    `);
    return {
      ready: Number(row?.ready ?? 0),
      claimed: Number(row?.claimed ?? 0),
    };
  }
}
