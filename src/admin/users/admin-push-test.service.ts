import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/app-exception';
import {
  ApnsService,
  parseApnsEnvironment,
  type PushPayload,
} from '../../notifications/apns.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminRateLimiter } from '../admin-rate-limiter';
import {
  AdminAuditService,
  type AdminActor,
} from '../audit/admin-audit.service';
import type { PushTestResult } from '../contract';
import { userNotFound } from './admin-users.service';
import { isOwnerAccount } from './owner-account';

/** Testowych pushy na admina na minutę — to ręczna diagnoza, nie wysyłka. */
export const PUSH_TEST_PER_MINUTE = 5;

/**
 * Treść neutralna: bez imienia, bez danych konta, bez `data` (aplikacja nie
 * ma czego otwierać). `active`, żeby było go widać na ekranie blokady,
 * i krótkie życie — test sprzed godziny nie ma już sensu.
 */
export const PUSH_TEST_PAYLOAD: PushPayload = {
  title: 'Scoffie',
  body: 'Test z panelu Scoffie',
  collapseId: 'scoffie-admin-test',
  interruptionLevel: 'active',
  priority: 10,
  expirationSeconds: 300,
};

/**
 * Testowy push na jedno urządzenie z karty osoby (ROADMAPA §5.10).
 *
 * Idzie ISTNIEJĄCĄ drogą `ApnsService` (ten sam JWT, host wg środowiska
 * urządzenia, topic = bundle id urządzenia), ale z pełną odpowiedzią APNs
 * zamiast cichego logu — panel pokazuje status, `apns-id` i powód odmowy.
 * Świadomie NIE przez `NotificationsService`: test nie zapisuje niczego do
 * historii powiadomień osoby, nie próbuje drugiego środowiska i nie
 * wyłącza urządzenia po `BadDeviceToken` — ma pokazać stan, nie go zmieniać.
 *
 * DECYZJA: domyślnie tylko urządzenia kont z listy właściciela
 * (`ADMIN_BOOTSTRAP_EMAIL`) — właściciel sprawdza własny telefon. Push na
 * telefon obcej osoby to wejście w jej ekran blokady: wolno, bo bywa
 * potrzebne przy zgłoszeniu „nie dostaję powiadomień”, ale dopiero po
 * jawnym potwierdzeniu w panelu („wyślesz push do <imię>”) i z powodem,
 * który trafia do dziennika audytu. Bez tego backend odpowiada 403, więc
 * pominięcie okna po stronie panelu niczego nie wyśle.
 */
@Injectable()
export class AdminPushTestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    private readonly apns: ApnsService,
    private readonly limiter: AdminRateLimiter,
  ) {}

  async send(
    actor: AdminActor,
    userId: string,
    deviceId: string,
    input: { confirmForeign?: boolean; reason?: string },
  ): Promise<PushTestResult> {
    this.limiter.check(
      `push-test:${actor.adminUserId ?? actor.adminEmail}`,
      PUSH_TEST_PER_MINUTE,
    );

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user) throw userNotFound();
    const device = await this.prisma.pushDevice.findFirst({
      where: { id: deviceId, userId },
      select: {
        deviceToken: true,
        appBundleId: true,
        apnsEnvironment: true,
      },
    });
    if (!device) {
      throw new AppException(
        'NOT_FOUND',
        'Ta osoba nie ma takiego urządzenia.',
        HttpStatus.NOT_FOUND,
      );
    }

    const foreign = !isOwnerAccount(user.email);
    const reason = input.reason?.trim() || null;
    if (foreign && (input.confirmForeign !== true || !reason)) {
      throw new AppException(
        'FORBIDDEN',
        'Urządzenie osoby spoza listy właściciela — potwierdź wysyłkę i podaj powód.',
        HttpStatus.FORBIDDEN,
        ['confirmForeign', 'reason'],
      );
    }
    if (!this.apns.isConfigured()) {
      throw new AppException(
        'SERVICE_UNAVAILABLE',
        'APNs nie jest skonfigurowany (APNS_ENABLED i klucze APNS_*).',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const environment =
      parseApnsEnvironment(device.apnsEnvironment) ??
      this.apns.defaultEnvironment;
    return this.audit.run(
      actor,
      {
        action: 'user.push.test',
        targetType: 'PushDevice',
        targetId: deviceId,
        reason,
        details: { userId, foreign, environment },
      },
      async () => {
        const result = await this.apns.sendWithResult(
          device.deviceToken,
          PUSH_TEST_PAYLOAD,
          device.appBundleId,
          environment,
        );
        return {
          ok: result.status === 200,
          status: result.status,
          apnsId: result.apnsId,
          reason: result.reason,
          environment: result.environment,
          topic: result.topic,
          sentAt: new Date().toISOString(),
        };
      },
      (result) => ({
        status: result.status,
        apnsReason: result.reason,
        apnsId: result.apnsId,
      }),
    );
  }
}
