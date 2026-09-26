import { createHash, timingSafeEqual } from 'crypto';
import {
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  Query,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { DeployTrackerService } from './deploy-tracker.service';
import { readRailwayWebhookToken } from './integrations-env';

/** Porównanie w stałym czasie — skróty mają zawsze tę samą długość. */
export function sameSecret(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Webhook Railwaya (Project Settings → Webhooks, zdarzenia `Deployment.*`)
 * na `/webhooks/railway?token=…`. Railway nie podpisuje wywołań, więc
 * treści nie czytamy wcale — to tylko szturchnięcie: backend sam pyta
 * Railway tokenem projektu (`DeployTrackerService`). Podrobione wywołanie
 * może więc najwyżej wywołać odczyt, zlewany do jednego na 3 s.
 *
 * Brak `RAILWAY_WEBHOOK_TOKEN` albo zły token → 404, jakby trasy nie było.
 * Token w adresie wycina z logów `redactUrl`.
 */
@ApiExcludeController()
@Controller('webhooks/railway')
export class RailwayWebhookController {
  constructor(private readonly tracker: DeployTrackerService) {}

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  receive(@Query('token') token: unknown): void {
    const expected = readRailwayWebhookToken();
    if (
      !expected ||
      typeof token !== 'string' ||
      !sameSecret(token, expected)
    ) {
      throw new NotFoundException();
    }
    this.tracker.poke();
  }
}
