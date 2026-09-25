import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DataExportController } from './data-export.controller';
import { DataExportService } from './data-export.service';

/** `PrismaModule` jest globalny; `AuthModule` daje `JwtAuthGuard`. */
@Module({
  imports: [AuthModule],
  controllers: [DataExportController],
  providers: [DataExportService],
  // Panel administratora oddaje TĘ SAMĄ paczkę przy wniosku z art. 15/20.
  exports: [DataExportService],
})
export class DataExportModule {}
