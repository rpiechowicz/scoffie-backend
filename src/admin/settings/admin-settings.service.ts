import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/app-exception';
import { readAgentEnv } from '../../config/agent-env';
import {
  isRuntimeSettingKey,
  RUNTIME_SETTING_KEYS,
  RUNTIME_SETTINGS,
  type RuntimeSettingKey,
} from '../../config/runtime-settings';
import { OpsAlertService } from '../../observability/ops-alert.service';
import { RuntimeSettingsService } from '../../runtime-settings/runtime-settings.service';
import {
  AdminAuditService,
  type AdminActor,
} from '../audit/admin-audit.service';
import type { RuntimeSettingsData } from '../contract';

/**
 * „Sterowanie” (ROADMAPA §5.12): wyłącznik i limity asystenta nadpisywane
 * z panelu. Każda zmiana: step-up (kontroler), powód, wpis audytu i alert —
 * wyłączony asystent to decyzja, o której operator ma wiedzieć od razu.
 */
@Injectable()
export class AdminSettingsService {
  constructor(
    private readonly runtime: RuntimeSettingsService,
    private readonly audit: AdminAuditService,
    private readonly alerts: OpsAlertService,
  ) {}

  async data(): Promise<RuntimeSettingsData> {
    const rows = new Map(
      (await this.runtime.list()).map((row) => [row.key, row]),
    );
    const agent = readAgentEnv();
    return {
      settings: RUNTIME_SETTING_KEYS.map((key) => {
        const spec = RUNTIME_SETTINGS[key];
        const row = rows.get(key);
        const envRaw = process.env[key];
        return {
          key,
          label: spec.label,
          kind: spec.kind,
          envValue: envRaw === undefined ? null : envRaw.trim(),
          override: row?.value ?? null,
          effective: spec.effective(agent),
          updatedAt: row?.updatedAt.toISOString() ?? null,
          updatedBy: row?.updatedBy ?? null,
          reason: row?.reason ?? null,
        };
      }),
    };
  }

  async set(
    actor: AdminActor,
    rawKey: string,
    value: string,
    reason: string,
  ): Promise<void> {
    const key = this.assertKey(rawKey);
    const result = await this.audit.run(
      actor,
      {
        action: 'settings.set',
        targetType: 'RuntimeSetting',
        targetId: key,
        reason,
      },
      () =>
        this.runtime.set(key, value, { updatedBy: actor.adminEmail, reason }),
      (done) => ({
        value: describe(key, done.value),
        previous: done.previous === null ? null : describe(key, done.previous),
      }),
    );
    void this.alerts.notify(
      `runtime-setting:${key}:${Date.now()}`,
      key === 'AI_ENABLED'
        ? `Asystent ${result.value === 'true' ? 'włączony' : 'wyłączony'} z panelu przez ${actor.adminEmail}: „${reason.trim()}”.`
        : `Panel: ${key} = ${describe(key, result.value)} (${actor.adminEmail}): „${reason.trim()}”.`,
    );
  }

  async clear(
    actor: AdminActor,
    rawKey: string,
    reason: string,
  ): Promise<void> {
    const key = this.assertKey(rawKey);
    const result = await this.audit.run(
      actor,
      {
        action: 'settings.clear',
        targetType: 'RuntimeSetting',
        targetId: key,
        reason,
      },
      () => this.runtime.clear(key),
      (done) => ({ previous: describe(key, done.previous) }),
    );
    const now = RUNTIME_SETTINGS[key].effective(readAgentEnv());
    void this.alerts.notify(
      `runtime-setting:${key}:${Date.now()}`,
      key === 'AI_ENABLED'
        ? `Wyłącznik asystenta wraca do Railwaya (teraz ${now === 'true' ? 'włączony' : 'wyłączony'}, było ${result.previous === 'true' ? 'włączony' : 'wyłączony'}) — ${actor.adminEmail}: „${reason.trim()}”.`
        : `Panel: ${key} wraca do wartości z Railwaya (${describe(key, now)}) — ${actor.adminEmail}: „${reason.trim()}”.`,
    );
  }

  /** Klucz spoza białej listy = 404, zanim cokolwiek trafi do audytu. */
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

/**
 * Wartość do audytu i alertu. Lista osób to adresy e-mail — do dziennika
 * idzie tylko ich liczba („bez danych osobowych”).
 */
function describe(key: RuntimeSettingKey, value: string): string {
  if (key !== 'AI_ALLOWED_USERS') return value;
  const count = value.split(',').filter(Boolean).length;
  return count === 0 ? 'wszyscy' : `${count} os.`;
}
