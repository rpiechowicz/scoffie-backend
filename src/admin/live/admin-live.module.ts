import { Module } from '@nestjs/common';
import { AdminCoreModule } from '../admin-core.module';
import { AdminLiveService } from './admin-live.service';

/**
 * Kanał na żywo panelu (`/admin/ws`) — bez kontrolera: gniazdo podpina się
 * pod `upgrade` serwera HTTP (szczegóły w `admin-live.service.ts`).
 */
@Module({
  imports: [AdminCoreModule],
  providers: [AdminLiveService],
})
export class AdminLiveModule {}
