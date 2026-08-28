import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppExceptionFilter } from './app-exception.filter';
import { WsTelemetryService } from './ws-telemetry.service';

@Global()
@Module({
  providers: [
    WsTelemetryService,
    // Jeden kształt błędu HTTP dla całej aplikacji — patrz `error-contract.ts`.
    // Rejestrowany tu, a nie w `main.ts`, żeby `@nestjs/testing` też go miał.
    { provide: APP_FILTER, useClass: AppExceptionFilter },
  ],
  exports: [WsTelemetryService],
})
export class CommonModule {}
