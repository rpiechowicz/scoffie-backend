import { Module } from '@nestjs/common';
import { DeployTrackerService } from './deploy-tracker.service';
import { RailwayWebhookController } from './railway-webhook.controller';

/**
 * Wdrożenia Railway na żywo — jedna instancja na proces, wspólna dla ekranu
 * „System” (`AdminIntegrationsService`), przebiegu alertów
 * (`AdminWatchService`) i webhooka Railwaya.
 */
@Module({
  controllers: [RailwayWebhookController],
  providers: [DeployTrackerService],
  exports: [DeployTrackerService],
})
export class DeployTrackerModule {}
