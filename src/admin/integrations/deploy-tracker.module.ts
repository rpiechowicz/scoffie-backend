import { Module } from '@nestjs/common';
import { DeployTrackerService } from './deploy-tracker.service';
import { RailwayWebhookController } from './railway-webhook.controller';
import { SentrySnapshotService } from './sentry-snapshot.service';

/**
 * Wdrożenia Railway na żywo — jedna instancja na proces, wspólna dla ekranu
 * „System” (`AdminIntegrationsService`), przebiegu alertów
 * (`AdminWatchService`) i webhooka Railwaya. Do tego ostatni odczyt Sentry
 * z przebiegu alertów — zasiewa pamięć ekranu „System”.
 */
@Module({
  controllers: [RailwayWebhookController],
  providers: [DeployTrackerService, SentrySnapshotService],
  exports: [DeployTrackerService, SentrySnapshotService],
})
export class DeployTrackerModule {}
