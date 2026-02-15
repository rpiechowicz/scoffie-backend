import { Injectable, Logger } from '@nestjs/common';
import { PushPlatform } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ApnsSendError, ApnsService } from './apns.service';

type PlanChangeAction = 'UPSERT_SLOT' | 'REMOVE_SLOT' | 'SAVE_PLAN' | 'CLEAR_PLAN' | string;

type PlanChangeContext = {
  dayOfWeek?: string | null;
  mealType?: string | null;
  weekStart?: string | null;
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly dedupeWindowDefaultMs = 1500;
  private readonly dedupeWindowPlanWideMs = 8000;
  private readonly dedupeCache = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly apnsService: ApnsService,
  ) {}

  async registerDevice(params: {
    userId: string;
    deviceToken: string;
    platform?: PushPlatform;
    appBundleId?: string;
  }): Promise<{ success: boolean }> {
    const normalizedToken = this.normalizeDeviceToken(params.deviceToken);
    if (!normalizedToken) {
      return { success: false };
    }

    await this.prisma.pushDevice.upsert({
      where: { deviceToken: normalizedToken },
      create: {
        userId: params.userId,
        deviceToken: normalizedToken,
        platform: params.platform ?? PushPlatform.IOS,
        appBundleId: params.appBundleId ?? process.env.APNS_BUNDLE_ID ?? 'weeklymeals',
        isActive: true,
        lastSeenAt: new Date(),
      },
      update: {
        userId: params.userId,
        platform: params.platform ?? PushPlatform.IOS,
        appBundleId: params.appBundleId ?? process.env.APNS_BUNDLE_ID ?? 'weeklymeals',
        isActive: true,
        lastSeenAt: new Date(),
      },
    });

    return { success: true };
  }

  async notifyWeeklyPlanChanged(params: {
    householdId: string;
    changedByUserId: string;
    changedByDisplayName?: string | null;
    action?: PlanChangeAction;
    context?: PlanChangeContext;
  }): Promise<void> {
    if (!this.apnsService.isConfigured()) {
      return;
    }

    if (this.isDuplicateEvent(params)) {
      return;
    }

    const targetUsers = await this.prisma.membership.findMany({
      where: {
        householdId: params.householdId,
        userId: { not: params.changedByUserId },
      },
      select: { userId: true },
    });

    const userIds = targetUsers.map((x) => x.userId);
    if (!userIds.length) {
      return;
    }

    const devices = await this.prisma.pushDevice.findMany({
      where: {
        userId: { in: userIds },
        isActive: true,
        platform: PushPlatform.IOS,
      },
      select: { id: true, deviceToken: true, appBundleId: true },
    });

    if (!devices.length) {
      return;
    }

    const actor = params.changedByDisplayName?.trim() || 'Ktoś';
    const body = this.buildPlanChangeMessage(actor, params.action, params.context);
    const data = {
      householdId: params.householdId,
      action: (params.action ?? 'UPDATE').toString(),
      type: 'WEEKLY_PLAN_CHANGED',
      dayOfWeek: params.context?.dayOfWeek?.toString() ?? '',
      mealType: params.context?.mealType?.toString() ?? '',
    };

    await Promise.all(
      devices.map(async (device) => {
        try {
          await this.apnsService.sendToDevice(device.deviceToken, {
            title: 'Plan posiłków',
            body,
            data,
          }, device.appBundleId);
        } catch (error) {
          if (this.shouldDeactivateToken(error)) {
            await this.prisma.pushDevice.update({
              where: { id: device.id },
              data: { isActive: false },
            });
          }
        }
      }),
    );
  }

  private normalizeDeviceToken(token: string): string {
    return token.replace(/[<>\s]/g, '').trim();
  }

  private shouldDeactivateToken(error: unknown): boolean {
    if (!(error instanceof ApnsSendError)) {
      return false;
    }

    if (error.status === 410 || error.status === 404) {
      return true;
    }

    const body = error.responseBody ?? '';
    return (
      body.includes('BadDeviceToken') ||
      body.includes('Unregistered') ||
      body.includes('DeviceTokenNotForTopic')
    );
  }

  private isDuplicateEvent(params: {
    householdId: string;
    changedByUserId: string;
    action?: PlanChangeAction;
    context?: PlanChangeContext;
  }): boolean {
    const action = (params.action ?? 'UPDATE').toString().toUpperCase();
    const weekStart = params.context?.weekStart ?? '';
    const key = [
      params.householdId,
      params.changedByUserId,
      action,
      weekStart,
      params.context?.dayOfWeek ?? '',
      params.context?.mealType ?? '',
    ].join('|');

    const now = Date.now();
    const previous = this.dedupeCache.get(key);
    this.dedupeCache.set(key, now);

    const dedupeWindowMs =
      action === 'SAVE_PLAN' || action === 'CLEAR_PLAN'
        ? this.dedupeWindowPlanWideMs
        : this.dedupeWindowDefaultMs;

    for (const [cacheKey, ts] of this.dedupeCache.entries()) {
      if (now - ts > this.dedupeWindowPlanWideMs) {
        this.dedupeCache.delete(cacheKey);
      }
    }

    return Boolean(previous && now - previous < dedupeWindowMs);
  }

  private buildPlanChangeMessage(
    actor: string,
    action?: PlanChangeAction,
    context?: PlanChangeContext,
  ): string {
    const meal = this.mapMealType(context?.mealType);
    const day = this.mapDayOfWeek(context?.dayOfWeek);
    const mealForMessage = meal.toLowerCase();
    const dayForMessage = day.toLowerCase();

    switch ((action ?? '').toUpperCase()) {
      case 'SAVE_PLAN':
        return `${actor} ustawił plan posiłków na ten tydzień.`;
      case 'CLEAR_PLAN':
        return `${actor} usunął plan posiłków na ten tydzień.`;
      case 'REMOVE_SLOT':
        if (context?.mealType && context?.dayOfWeek) {
          return `${actor} usunął ${mealForMessage} z planu na ${dayForMessage}.`;
        }
        return `${actor} usunął pozycję z planu posiłków.`;
      case 'UPSERT_SLOT':
        if (context?.mealType && context?.dayOfWeek) {
          return `${actor} edytował plan ${mealForMessage} na ${dayForMessage}.`;
        }
        return `${actor} zaktualizował plan posiłków.`;
      default:
        return `${actor} zmienił plan posiłków.`;
    }
  }

  private mapMealType(value?: string | null): string {
    switch ((value ?? '').toUpperCase()) {
      case 'BREAKFAST':
        return 'Śniadanie';
      case 'LUNCH':
        return 'Obiad';
      case 'DINNER':
        return 'Kolację';
      default:
        return 'Posiłek';
    }
  }

  private mapDayOfWeek(value?: string | null): string {
    switch ((value ?? '').toUpperCase()) {
      case 'MON':
        return 'Poniedziałek';
      case 'TUE':
        return 'Wtorek';
      case 'WED':
        return 'Środę';
      case 'THU':
        return 'Czwartek';
      case 'FRI':
        return 'Piątek';
      case 'SAT':
        return 'Sobotę';
      case 'SUN':
        return 'Niedzielę';
      default:
        return 'wybrany dzień';
    }
  }
}
