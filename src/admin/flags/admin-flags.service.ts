import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/app-exception';
import { FeatureFlagsService } from '../../feature-flags/feature-flags.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AdminAuditService,
  type AdminActor,
} from '../audit/admin-audit.service';
import type {
  FeatureFlagCreate,
  FeatureFlagsData,
  FeatureFlagUpdate,
  HouseholdFlagsData,
} from '../contract';

const conflict = (message: string) =>
  new AppException('CONFLICT', message, HttpStatus.CONFLICT, [message]);

const notFound = (message: string) =>
  new AppException('NOT_FOUND', message, HttpStatus.NOT_FOUND);

/**
 * Ekran „Flagi” i sekcja „Bety” na karcie gospodarstwa. Każdy zapis: step-up
 * (kontroler), powód, wpis audytu i natychmiastowe odświeżenie pamięci flag
 * — aplikacja widzi zmianę od następnego `GET /me/flags` (druga instancja
 * najpóźniej po 30 s).
 */
@Injectable()
export class AdminFlagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagsService,
    private readonly audit: AdminAuditService,
  ) {}

  async data(): Promise<FeatureFlagsData> {
    const [rows, counts] = await Promise.all([
      this.prisma.featureFlag.findMany({ orderBy: { key: 'asc' } }),
      this.prisma.featureFlagHousehold.groupBy({
        by: ['flagKey', 'enabled'],
        _count: { _all: true },
      }),
    ]);
    const count = (key: string, enabled: boolean) =>
      counts.find((c) => c.flagKey === key && c.enabled === enabled)?._count
        ._all ?? 0;
    return {
      flags: rows.map((row) => ({
        key: row.key,
        description: row.description,
        enabled: row.enabled,
        rolloutPercent: row.rolloutPercent,
        overridesOn: count(row.key, true),
        overridesOff: count(row.key, false),
        updatedAt: row.updatedAt.toISOString(),
        updatedBy: row.updatedBy,
      })),
    };
  }

  async create(actor: AdminActor, input: FeatureFlagCreate): Promise<void> {
    await this.audit.run(
      actor,
      {
        action: 'flags.create',
        targetType: 'FeatureFlag',
        targetId: input.key,
        reason: input.reason,
        details: {
          enabled: input.enabled,
          rolloutPercent: input.rolloutPercent,
        },
      },
      async () => {
        const existing = await this.prisma.featureFlag.findUnique({
          where: { key: input.key },
          select: { key: true },
        });
        if (existing) {
          throw conflict(`Flaga ${input.key} już istnieje.`);
        }
        await this.prisma.featureFlag.create({
          data: {
            key: input.key,
            description: input.description.trim(),
            enabled: input.enabled,
            rolloutPercent: input.rolloutPercent,
            updatedBy: actor.adminEmail,
          },
        });
      },
    );
    await this.flags.refresh();
  }

  async update(
    actor: AdminActor,
    key: string,
    input: FeatureFlagUpdate,
  ): Promise<void> {
    await this.audit.run(
      actor,
      {
        action: 'flags.update',
        targetType: 'FeatureFlag',
        targetId: key,
        reason: input.reason,
      },
      async () => {
        const previous = await this.prisma.featureFlag.findUnique({
          where: { key },
        });
        if (!previous) throw notFound('Nie ma takiej flagi.');
        await this.prisma.featureFlag.update({
          where: { key },
          data: {
            ...(input.description !== undefined
              ? { description: input.description.trim() }
              : {}),
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
            ...(input.rolloutPercent !== undefined
              ? { rolloutPercent: input.rolloutPercent }
              : {}),
            updatedBy: actor.adminEmail,
          },
        });
        return previous;
      },
      (previous) => ({
        before: {
          enabled: previous.enabled,
          rolloutPercent: previous.rolloutPercent,
        },
        after: {
          enabled: input.enabled ?? previous.enabled,
          rolloutPercent: input.rolloutPercent ?? previous.rolloutPercent,
        },
      }),
    );
    await this.flags.refresh();
  }

  async remove(actor: AdminActor, key: string, reason: string): Promise<void> {
    await this.audit.run(
      actor,
      {
        action: 'flags.delete',
        targetType: 'FeatureFlag',
        targetId: key,
        reason,
      },
      async () => {
        const removed = await this.prisma.featureFlag
          .delete({ where: { key }, select: { key: true } })
          .catch((error: unknown) => {
            if ((error as { code?: string }).code === 'P2025') return null;
            throw error;
          });
        if (!removed) throw notFound('Nie ma takiej flagi.');
      },
    );
    await this.flags.refresh();
  }

  async household(householdId: string): Promise<HouseholdFlagsData> {
    const [household, rows, overrides] = await Promise.all([
      this.prisma.household.findUnique({
        where: { id: householdId },
        select: { id: true },
      }),
      this.prisma.featureFlag.findMany({ orderBy: { key: 'asc' } }),
      this.prisma.featureFlagHousehold.findMany({
        where: { householdId },
        select: { flagKey: true, enabled: true },
      }),
    ]);
    if (!household) throw notFound('Nie ma takiego gospodarstwa.');
    const byKey = new Map(overrides.map((o) => [o.flagKey, o.enabled]));
    return {
      householdId,
      flags: rows.map((row) => {
        const override = byKey.get(row.key);
        const result = this.flags.explain(row, householdId, override);
        return {
          key: row.key,
          description: row.description,
          override: override ?? null,
          effective: result.value,
          source: result.source,
        };
      }),
    };
  }

  async setOverride(
    actor: AdminActor,
    key: string,
    householdId: string,
    enabled: boolean,
    reason: string,
  ): Promise<void> {
    await this.audit.run(
      actor,
      {
        action: 'flags.household.set',
        targetType: 'Household',
        targetId: householdId,
        reason,
        details: { flag: key, enabled },
      },
      async () => {
        await this.assertTargets(key, householdId);
        await this.prisma.featureFlagHousehold.upsert({
          where: { flagKey_householdId: { flagKey: key, householdId } },
          create: {
            flagKey: key,
            householdId,
            enabled,
            updatedBy: actor.adminEmail,
          },
          update: { enabled, updatedBy: actor.adminEmail },
        });
      },
    );
    await this.flags.refresh();
  }

  async clearOverride(
    actor: AdminActor,
    key: string,
    householdId: string,
    reason: string,
  ): Promise<void> {
    await this.audit.run(
      actor,
      {
        action: 'flags.household.clear',
        targetType: 'Household',
        targetId: householdId,
        reason,
        details: { flag: key },
      },
      async () => {
        const removed = await this.prisma.featureFlagHousehold.deleteMany({
          where: { flagKey: key, householdId },
        });
        if (removed.count === 0) {
          throw notFound('Ten dom nie ma nadpisania tej flagi.');
        }
      },
    );
    await this.flags.refresh();
  }

  private async assertTargets(key: string, householdId: string) {
    const [flag, household] = await Promise.all([
      this.prisma.featureFlag.findUnique({
        where: { key },
        select: { key: true },
      }),
      this.prisma.household.findUnique({
        where: { id: householdId },
        select: { id: true },
      }),
    ]);
    if (!flag) throw notFound('Nie ma takiej flagi.');
    if (!household) throw notFound('Nie ma takiego gospodarstwa.');
  }
}
