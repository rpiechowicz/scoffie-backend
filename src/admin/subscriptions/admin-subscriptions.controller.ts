import { Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { AdminController } from '../admin-controller.decorator';
import type { AdminAccessContext } from '../admin-request';
import {
  AdminAccess,
  AdminRequires,
  CurrentAdminSession,
} from '../admin.decorators';
import { adminActor, AdminAuditService } from '../audit/admin-audit.service';
import type { ResolvedAdminSession } from '../auth/admin-sessions.service';
import type { SubscriptionsData } from '../contract';
import {
  AdminSubscriptionsService,
  assertNotificationId,
} from './admin-subscriptions.service';

/**
 * Subskrypcje i przychód (ROADMAPA §5.6). Ponowienie powiadomienia nie ma
 * step-upu: nie nadaje ani nie odbiera niczego samo z siebie, tylko prosi
 * domenę o przetworzenie zdarzenia, które Apple już podpisało — tą samą
 * ścieżką co godzinny przebieg uzgadniania.
 */
@AdminController('subscriptions')
export class AdminSubscriptionsController {
  constructor(
    private readonly subscriptions: AdminSubscriptionsService,
    private readonly audit: AdminAuditService,
  ) {}

  @Get()
  @AdminRequires('subscriptions.read')
  data(): Promise<SubscriptionsData> {
    return this.subscriptions.data();
  }

  @Post('notifications/:id/retry')
  @AdminRequires('subscriptions.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async retry(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Param('id') rawId: string,
  ): Promise<void> {
    const uuid = assertNotificationId(rawId);
    await this.audit.run(
      adminActor(session, access),
      {
        action: 'subscription.notification.retry',
        targetType: 'AppleNotification',
        targetId: uuid,
      },
      () => this.subscriptions.retryNotification(uuid),
      (result) => ({
        notificationType: result.notificationType,
        note: result.note,
      }),
    );
  }
}
