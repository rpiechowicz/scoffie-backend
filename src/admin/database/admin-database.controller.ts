import { Get } from '@nestjs/common';
import { AdminController } from '../admin-controller.decorator';
import { AdminRequires } from '../admin.decorators';
import type { DatabaseData } from '../contract';
import { AdminDatabaseService } from './admin-database.service';

/** Karta „Baza danych” w „Systemie” — obok `AdminOpsController` (Railway, Sentry). */
@AdminController('ops')
export class AdminDatabaseController {
  constructor(private readonly db: AdminDatabaseService) {}

  @Get('database')
  @AdminRequires('ops.read')
  database(): Promise<DatabaseData> {
    return this.db.database();
  }
}
