import { Global, Module } from '@nestjs/common';
import { RuntimeSettingsService } from './runtime-settings.service';

/**
 * Nadpisania env z panelu (ROADMAPA §5.12). Globalny, bo serwis musi wstać
 * zawsze — także gdy nikt go nie wstrzykuje: to on wczytuje nadpisania
 * z bazy przy starcie i trzyma je świeże dla `readAgentEnv()`.
 */
@Global()
@Module({
  providers: [RuntimeSettingsService],
  exports: [RuntimeSettingsService],
})
export class RuntimeSettingsModule {}
