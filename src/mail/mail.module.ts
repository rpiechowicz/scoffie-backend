import { Module } from '@nestjs/common';
import { ObservabilityModule } from '../observability/observability.module';
import { MailOutboxService } from './mail-outbox.service';
import { MailRenderer } from './mail-renderer';
import { MailWorkerService } from './mail-worker.service';
import { MailWebhookController } from './mail-webhook.controller';
import { MAIL_CLIENT, MailClient } from './providers/mail-client';
import { ResendMailClient } from './providers/resend.client';
import { StubMailClient } from './providers/stub.client';
import { readMailEnv } from './mail-env';

/**
 * Poczta transakcyjna. Moduł JEDNOKIERUNKOWY w drugą stronę niż asystent:
 * to domena woła `MailOutboxService`, a `src/mail/` nie zna ani domeny, ani
 * `src/agent/`. Dzięki temu asystentowi wolno zakolejkować maila (kwota,
 * wyczerpana pula), a poczcie nie wolno sięgnąć do asystenta.
 */
@Module({
  // Po `OpsAlertService` — jedyna rzecz spoza modułu, której potrzebuje
  // robotnik: nieudany mail ma obudzić operatora, a nie tylko log.
  imports: [ObservabilityModule],
  controllers: [MailWebhookController],
  providers: [
    MailOutboxService,
    MailRenderer,
    MailWorkerService,
    {
      provide: MAIL_CLIENT,
      // Przez fabrykę, bo konstruktory mają domyślne argumenty (fetch) dla
      // testów, a DI próbowałoby je wstrzyknąć — ten sam wzorzec co przy
      // `OpsAlertService`.
      useFactory: (): MailClient =>
        readMailEnv().transport === 'resend'
          ? new ResendMailClient()
          : new StubMailClient(),
    },
  ],
  exports: [MailOutboxService, MailRenderer],
})
export class MailModule {}
