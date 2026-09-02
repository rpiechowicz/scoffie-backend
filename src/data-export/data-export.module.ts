import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DataExportController } from './data-export.controller';
import { DataExportService } from './data-export.service';

/** `PrismaModule` jest globalny; `AuthModule` daje `JwtAuthGuard`. */
@Module({
  imports: [AuthModule],
  controllers: [DataExportController],
  providers: [DataExportService],
})
export class DataExportModule {}
