import { Get } from '@nestjs/common';
import { AdminController } from '../admin-controller.decorator';
import { CurrentAdminSession } from '../admin.decorators';
import type { ResolvedAdminSession } from '../auth/admin-sessions.service';
import type { AdminBadges } from '../contract';
import { AdminBadgesService } from './admin-badges.service';

/**
 * Liczniki paska bocznego. Sama sesja panelu wystarczy — uprawnienia
 * sprawdza serwis per pole (brak → `null`), więc jedna trasa służy każdej roli.
 */
@AdminController('badges')
export class AdminBadgesController {
  constructor(private readonly badges: AdminBadgesService) {}

  @Get()
  get(
    @CurrentAdminSession() session: ResolvedAdminSession | null,
  ): Promise<AdminBadges> {
    return this.badges.badges(session?.admin.role ?? '');
  }
}
