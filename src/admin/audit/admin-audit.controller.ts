import { Get, Query } from '@nestjs/common';
import { AdminController } from '../admin-controller.decorator';
import { AdminRequires } from '../admin.decorators';
import type { AuditPage } from '../contract';
import { AdminAuditLogService } from './admin-audit-log.service';
import { AdminAuditQueryDto } from './admin-audit.dto';

/** Dziennik audytu panelu — tylko odczyt, bez step-upu. */
@AdminController('audit')
export class AdminAuditController {
  constructor(private readonly log: AdminAuditLogService) {}

  @Get()
  @AdminRequires('audit.read')
  page(@Query() query: AdminAuditQueryDto): Promise<AuditPage> {
    return this.log.page(query);
  }
}
