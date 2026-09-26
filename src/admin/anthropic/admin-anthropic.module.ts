import { Module } from '@nestjs/common';
import { AdminCoreModule } from '../admin-core.module';
import { AdminAnthropicController } from './admin-anthropic.controller';
import { AdminAnthropicService } from './admin-anthropic.service';

/** Kredyty Claude (Usage & Cost Admin API Anthropic + kotwice salda). */
@Module({
  imports: [AdminCoreModule],
  controllers: [AdminAnthropicController],
  providers: [AdminAnthropicService],
  exports: [AdminAnthropicService],
})
export class AdminAnthropicModule {}
