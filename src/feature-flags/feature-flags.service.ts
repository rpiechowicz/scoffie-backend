import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { currentHouseholdId } from '../households/current-household.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  evaluateFlag,
  evaluateFlags,
  type FlagDefinition,
  type FlagSource,
} from './feature-flags.evaluate';

/** Druga instancja (albo ręczna zmiana w bazie) dochodzi najpóźniej po tylu ms. */
export const FEATURE_FLAGS_REFRESH_MS = 30_000;

/** `GET /me/flags` */
export type MeFlagsResponse = {
  /** `{ klucz: włączona }` — tylko flagi, które istnieją; nieznany klucz = wyłączona. */
  flags: { [flagKey: string]: boolean };
};

type Snapshot = {
  flags: FlagDefinition[];
  /** householdId → (klucz flagi → nadpisanie) */
  overrides: Map<string, Map<string, boolean>>;
};

/**
 * Flagi funkcji (bety) per dom. Wzorem `RuntimeSettingsService`: cała tabela
 * w pamięci, odświeżana co 30 s i NATYCHMIAST po zapisie z panelu (`refresh`),
 * więc ocena jest synchroniczna i nie dotyka bazy. Nadpisań jest tyle, ilu
 * domów w betach — dziesiątki, nie tysiące — więc trzymamy je wszystkie.
 *
 * Gdy baza nie odpowiada, zostaje ostatni znany stan. Przed pierwszym udanym
 * odczytem wszystkie flagi są wyłączone (nieznana flaga = `false`) — beta
 * nigdy nie włącza się przez awarię.
 *
 * W kodzie funkcji: `flags.isEnabled('assistant.voice', householdId)`.
 */
@Injectable()
export class FeatureFlagsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FeatureFlagsService.name);
  private timer: NodeJS.Timeout | null = null;
  private snapshot: Snapshot = { flags: [], overrides: new Map() };

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(
      () => void this.refresh(),
      FEATURE_FLAGS_REFRESH_MS,
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(): Promise<void> {
    try {
      const [flags, overrides] = await Promise.all([
        this.prisma.featureFlag.findMany({
          select: { key: true, enabled: true, rolloutPercent: true },
        }),
        this.prisma.featureFlagHousehold.findMany({
          select: { flagKey: true, householdId: true, enabled: true },
        }),
      ]);
      const byHousehold = new Map<string, Map<string, boolean>>();
      for (const row of overrides) {
        const map =
          byHousehold.get(row.householdId) ?? new Map<string, boolean>();
        map.set(row.flagKey, row.enabled);
        byHousehold.set(row.householdId, map);
      }
      this.snapshot = { flags, overrides: byHousehold };
    } catch (error) {
      this.logger.warn(
        `nie udało się odświeżyć flag (zostają poprzednie): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Wszystkie flagi domu: nadpisanie domu > rollout > globalne. */
  resolveFlags(householdId: string | null): Record<string, boolean> {
    return evaluateFlags(
      this.snapshot.flags,
      householdId,
      householdId ? this.snapshot.overrides.get(householdId) : undefined,
    );
  }

  /** Bramka w kodzie funkcji. Nieznana flaga = `false`. */
  isEnabled(flagKey: string, householdId: string | null): boolean {
    const flag = this.snapshot.flags.find((f) => f.key === flagKey);
    if (!flag) return false;
    return evaluateFlag(
      flag,
      householdId,
      householdId
        ? this.snapshot.overrides.get(householdId)?.get(flagKey)
        : undefined,
    ).value;
  }

  /** Ocena z uzasadnieniem — dla panelu (karta gospodarstwa). */
  explain(
    flag: FlagDefinition,
    householdId: string,
    override: boolean | undefined,
  ): { value: boolean; source: FlagSource } {
    return evaluateFlag(flag, householdId, override);
  }

  /** `GET /me/flags` — flagi domu osoby z JWT. */
  async forUser(userId: string): Promise<MeFlagsResponse> {
    const householdId = await currentHouseholdId(this.prisma, userId);
    return { flags: this.resolveFlags(householdId) };
  }
}
