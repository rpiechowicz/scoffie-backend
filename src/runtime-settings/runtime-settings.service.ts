import {
  HttpStatus,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { AppException } from '../common/app-exception';
import {
  runtimeOverrides,
  setRuntimeOverrides,
} from '../config/runtime-overrides';
import {
  isRuntimeSettingKey,
  RUNTIME_SETTINGS,
  type RuntimeSettingKey,
} from '../config/runtime-settings';
import { PrismaService } from '../prisma/prisma.service';

/** Druga instancja (albo ręczna zmiana w bazie) dochodzi najpóźniej po tylu ms. */
export const RUNTIME_SETTINGS_REFRESH_MS = 30_000;

export type RuntimeSettingRow = {
  key: RuntimeSettingKey;
  value: string;
  updatedBy: string;
  reason: string;
  updatedAt: Date;
};

/**
 * Nadpisania env z panelu (ROADMAPA §5.12) — `RuntimeSetting` w bazie,
 * w pamięci procesu (`config/runtime-overrides.ts`) do synchronicznego
 * odczytu przez `readAgentEnv()`.
 *
 * Pamięć odświeża się co 30 s i NATYCHMIAST po zapisie z panelu: wyłącznik
 * asystenta działa od następnego żądania. Gdy baza nie odpowiada, zostają
 * ostatnie znane nadpisania — chwilowa awaria nie może po cichu włączyć
 * asystenta, który admin właśnie wyłączył.
 *
 * Wiersz spoza białej listy albo z wartością, której dziś nie da się
 * sparsować, jest pomijany (z ostrzeżeniem) — wtedy działa env.
 */
@Injectable()
export class RuntimeSettingsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RuntimeSettingsService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(
      () => void this.refresh(),
      RUNTIME_SETTINGS_REFRESH_MS,
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Kolejna aplikacja w tym samym procesie (e2e) zaczyna od czystego env.
    setRuntimeOverrides({});
  }

  /** Aktywne nadpisania — synchronicznie, bez bazy. */
  runtimeOverrides(): Readonly<Record<string, string>> {
    return runtimeOverrides();
  }

  async refresh(): Promise<void> {
    let rows: RuntimeSettingRow[];
    try {
      rows = await this.list();
    } catch (error) {
      this.logger.warn(
        `nie udało się odświeżyć nadpisań (zostają poprzednie): ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    const next: Record<string, string> = {};
    for (const row of rows) {
      const normalized = RUNTIME_SETTINGS[row.key].normalize(row.value);
      if (normalized.ok) next[row.key] = normalized.value;
      else
        this.logger.warn(`pomijam nadpisanie ${row.key}: ${normalized.error}`);
    }
    setRuntimeOverrides(next);
  }

  async list(): Promise<RuntimeSettingRow[]> {
    const rows = await this.prisma.runtimeSetting.findMany({
      orderBy: { key: 'asc' },
    });
    return rows.filter((row): row is RuntimeSettingRow =>
      isRuntimeSettingKey(row.key),
    );
  }

  /**
   * Zapis nadpisania. Zła wartość = 400 `VALIDATION_ERROR` (w env ta sama
   * wartość spadłaby na domyślną — tu człowiek ma zobaczyć błąd).
   */
  async set(
    rawKey: string,
    rawValue: string,
    meta: { updatedBy: string; reason: string },
  ): Promise<{
    key: RuntimeSettingKey;
    value: string;
    previous: string | null;
  }> {
    const key = this.assertKey(rawKey);
    const normalized = RUNTIME_SETTINGS[key].normalize(rawValue);
    if (!normalized.ok) {
      throw new AppException(
        'VALIDATION_ERROR',
        normalized.error,
        HttpStatus.BAD_REQUEST,
        [normalized.error],
      );
    }
    const previous = await this.prisma.runtimeSetting.findUnique({
      where: { key },
      select: { value: true },
    });
    const data = {
      value: normalized.value,
      updatedBy: meta.updatedBy,
      reason: meta.reason.trim(),
    };
    await this.prisma.runtimeSetting.upsert({
      where: { key },
      create: { key, ...data },
      update: data,
    });
    await this.refresh();
    return { key, value: normalized.value, previous: previous?.value ?? null };
  }

  /** Usunięcie nadpisania — wraca wartość z env. Brak nadpisania = 404. */
  async clear(
    rawKey: string,
  ): Promise<{ key: RuntimeSettingKey; previous: string }> {
    const key = this.assertKey(rawKey);
    const removed = await this.prisma.runtimeSetting
      .delete({ where: { key }, select: { value: true } })
      .catch((error: unknown) => {
        if ((error as { code?: string }).code === 'P2025') return null;
        throw error;
      });
    if (!removed) {
      throw new AppException(
        'NOT_FOUND',
        `${key} nie ma nadpisania z panelu.`,
        HttpStatus.NOT_FOUND,
      );
    }
    await this.refresh();
    return { key, previous: removed.value };
  }

  private assertKey(key: string): RuntimeSettingKey {
    if (!isRuntimeSettingKey(key)) {
      throw new AppException(
        'NOT_FOUND',
        'Tego ustawienia nie da się zmienić z panelu.',
        HttpStatus.NOT_FOUND,
      );
    }
    return key;
  }
}
