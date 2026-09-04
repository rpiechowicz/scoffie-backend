import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { readBillingEnv } from './billing-env';
import { SubscriptionsService } from './subscriptions.service';

/** Co godzinę: częściej nie ma po co, rzadziej robi się z tego reklamacja. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Pierwszy przebieg po dwóch minutach — nie w trakcie startu i healthchecku. */
const FIRST_SWEEP_DELAY_MS = 2 * 60 * 1000;
/** Ile subskrypcji odświeżamy w jednym przebiegu. */
const BATCH = 25;

/**
 * Siatka bezpieczeństwa pod płatności.
 *
 * DWA PROBLEMY, KTÓRYCH SAM WEBHOOK NIE ROZWIĄZUJE:
 *
 * 1. **Zgubione powiadomienie.** Apple ponawia przez trzy doby i przestaje.
 *    Jedno zgubione `DID_RENEW` to płacący klient bez PRO — i dowiadujemy się
 *    o tym z reklamacji, czyli najgorszym możliwym kanałem. Dlatego każda żywa
 *    subskrypcja jest odpytywana co `APPLE_RECONCILE_AFTER_HOURS`.
 * 2. **Powiadomienie zapisane, ale nieprzetworzone.** Zdarza się, gdy w chwili
 *    odbioru padła baza albo subskrypcji jeszcze nie było w naszej tabeli.
 *    Surowy ładunek leży zapisany, więc wystarczy spróbować jeszcze raz.
 *
 * Jedna instancja Railway, więc zwykły `setInterval` z `unref` — jak w
 * `AgentRetentionService`. Przy awarii Apple przebieg nic nie zmienia: metody
 * uzgadniania zwracają wtedy `false` i zostawiają stan nietknięty.
 */
@Injectable()
export class SubscriptionsReconcileService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(SubscriptionsReconcileService.name);
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly subscriptions: SubscriptionsService) {}

  onApplicationBootstrap(): void {
    if (!readBillingEnv().enabled) {
      this.logger.log(
        'Płatności wyłączone — uzgadnianie subskrypcji nie startuje.',
      );
      return;
    }
    this.first = setTimeout(() => {
      void this.sweep();
      this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
      this.timer.unref();
    }, FIRST_SWEEP_DELAY_MS);
    this.first.unref();
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = null;
    this.timer = null;
  }

  /** Jeden przebieg: najpierw zaległe zdarzenia, potem nieświeże subskrypcje. */
  async sweep(): Promise<{ notifications: number; reconciled: number }> {
    if (this.running) return { notifications: 0, reconciled: 0 };
    this.running = true;
    let notifications = 0;
    let reconciled = 0;
    try {
      for (const uuid of await this.subscriptions.unprocessedNotificationUuids(
        BATCH,
      )) {
        try {
          await this.subscriptions.processNotification(uuid);
          notifications += 1;
        } catch (error) {
          this.logger.warn(
            `Powiadomienie ${uuid} dalej się nie przetwarza: ${String(error)}`,
          );
        }
      }
      for (const id of await this.subscriptions.staleSubscriptionIds(BATCH)) {
        if (await this.subscriptions.reconcile(id)) reconciled += 1;
      }
      if (notifications > 0 || reconciled > 0) {
        this.logger.log(
          `Uzgadnianie: ${notifications} zdarzeń, ${reconciled} subskrypcji.`,
        );
      }
    } catch (error) {
      this.logger.error(`Przebieg uzgadniania padł: ${String(error)}`);
    } finally {
      this.running = false;
    }
    return { notifications, reconciled };
  }
}
