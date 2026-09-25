import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppExceptionFilter } from './app-exception.filter';
import { WsTelemetryService } from './ws-telemetry.service';
import { LiveEvents, liveEvents } from './live-events';

@Global()
@Module({
  providers: [
    WsTelemetryService,
    // Szyna kanału na żywo panelu — ta sama instancja, co `emitLive`.
    { provide: LiveEvents, useValue: liveEvents },
    // Jeden kształt błędu HTTP dla całej aplikacji — patrz `error-contract.ts`.
    // Rejestrowany tu, a nie w `main.ts`, żeby `@nestjs/testing` też go miał.
    { provide: APP_FILTER, useClass: AppExceptionFilter },
  ],
  exports: [WsTelemetryService, LiveEvents],
})
export class CommonModule {}
