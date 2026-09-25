import { Get, Query } from '@nestjs/common';
import { AdminController } from '../admin-controller.decorator';
import { AdminRequires } from '../admin.decorators';
import type { DashboardData, SearchResults } from '../contract';
import { AdminDashboardService } from './admin-dashboard.service';
import { AdminSearchService } from './admin-search.service';
import { AdminSearchQueryDto } from './admin-users.dto';

/** `GET /admin/dashboard` — pulpit. */
@AdminController('dashboard')
export class AdminDashboardController {
  constructor(private readonly dashboard: AdminDashboardService) {}

  @Get()
  @AdminRequires('dashboard.read')
  get(): Promise<DashboardData> {
    return this.dashboard.dashboard();
  }
}

/**
 * `GET /admin/search?q=` — ⌘K w panelu. Uprawnienie `users.read`: wynik to
 * przede wszystkim osoby (imię, e-mail); domy i przepisy są dodatkiem.
 */
@AdminController('search')
export class AdminSearchController {
  constructor(private readonly searchService: AdminSearchService) {}

  @Get()
  @AdminRequires('users.read')
  search(@Query() query: AdminSearchQueryDto): Promise<SearchResults> {
    return this.searchService.search(query.q);
  }
}
