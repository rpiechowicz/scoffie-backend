import { Module } from '@nestjs/common';
import { AdminCoreModule } from '../admin-core.module';
import { AdminTrafficController } from './admin-traffic.controller';
import { AdminTrafficService } from './admin-traffic.service';

/** Ekran „Ruch” panelu (Cloudflare GraphQL Analytics). */
@Module({
  imports: [AdminCoreModule],
  controllers: [AdminTrafficController],
  providers: [AdminTrafficService],
})
export class AdminTrafficModule {}
