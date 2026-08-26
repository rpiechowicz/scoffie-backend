import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PushPlatform } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ApnsSendError, ApnsService, PushPayload } from './apns.service';
import { NotificationBatcher } from './notification-batcher';
import { quietHoursDeferralMs } from './quiet-hours.util';
import {
  PlanChangeAction,
  PlanChangeEvent,
  ShoppingChangeAction,
  ShoppingChangeEvent,
  buildHouseholdInvitationCopy,
  buildHouseholdJoinedCopy,
  buildHouseholdLeftCopy,
  buildPlanSummary,
  buildShoppingSummary,
} from './notification-copy.util';

/**
 * Kanał powiadomień. Odpowiada jednemu przełącznikowi w Ustawieniach i jednej
 * kolumnie w `UserPreference` — trzeci wymiar (cisza nocna) jest osobno, bo
 * dotyczy pory, a nie tematu.
 */
export type NotificationChannel = 'plan' | 'shopping' | 'household';

interface BatchedPlanEvent extends PlanChangeEvent {
  householdId: string;
  changedByUserId: string;
  changedByDisplayName?: string | null;
}

interface BatchedShoppingEvent extends ShoppingChangeEvent {
  householdId: string;
  changedByUserId: string;
  changedByDisplayName?: string | null;
}

interface Recipient {
  userId: string;
  quietHours: boolean;
  timeZone: string | null;
}

/**
 * Okna zbierania. Wartości są w zmiennych środowiskowych, bo dobranie ich to
 * kwestia wyczucia, a nie prawdy: 60 s ciszy po ostatniej zmianie łapie typową
 * sesję układania planu (kolejne kratki idą co kilka sekund), a 5 minut sufitu
 * pilnuje, żeby ktoś planujący cały tydzień bez przerwy w końcu dostał
 * podsumowanie.
 */
/**
 * `Number('')` to zero, nie `NaN`, a `??` nie łapie pustego stringa — więc
 * `PUSH_BATCH_QUIET_MS=` w pliku `.env` (dokładnie tak, jak stoi w
 * `.env.example`) ustawiłby okno na 0 ms i przywrócił jedno powiadomienie na
 * zdarzenie. Stąd jawne odrzucanie wartości niedodatnich zamiast samego `??`.
 */
function envMs(raw: string | undefined, fallbackMs: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

const PLAN_BATCH_WINDOW_MS = envMs(process.env.PUSH_BATCH_QUIET_MS, 60_000);
const PLAN_BATCH_MAX_MS = envMs(process.env.PUSH_BATCH_MAX_MS, 300_000);
/**
 * Lista zakupów zbiera się dłużej, bo zakupy to jedna wyprawa do sklepu, a nie
 * seria decyzji — „odhaczył 12 produktów" po powrocie ze sklepu jest
 * użyteczne, dwanaście osobnych powiadomień przy półce nie jest.
 */
const SHOPPING_BATCH_WINDOW_MS = envMs(
  process.env.PUSH_SHOPPING_BATCH_QUIET_MS,
  180_000,
);
const SHOPPING_BATCH_MAX_MS = envMs(
  process.env.PUSH_SHOPPING_BATCH_MAX_MS,
  900_000,
);

/** Ile żyje zbiorcze powiadomienie, zanim APNs przestanie próbować. */
const SUMMARY_EXPIRATION_SECONDS = 2 * 60 * 60;

@Injectable()
export class NotificationsService implements OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);

  /**
   * Zbieracze trzymane per kategoria, a nie jeden wspólny: podsumowanie planu
   * i podsumowanie listy zakupów to dwa różne zdania i dwa różne przełączniki
   * w Ustawieniach, więc nie wolno ich zlać w jedną paczkę.
   */
  private readonly planBatcher: NotificationBatcher<BatchedPlanEvent>;
  private readonly shoppingBatcher: NotificationBatcher<BatchedShoppingEvent>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly apnsService: ApnsService,
  ) {
    this.planBatcher = new NotificationBatcher<BatchedPlanEvent>(
      { windowMs: PLAN_BATCH_WINDOW_MS, maxWaitMs: PLAN_BATCH_MAX_MS },
      (_key, events) => this.flushPlanBatch(events),
      (_key, events) =>
        this.resolveDeferralMs(
          events[0].householdId,
          events[0].changedByUserId,
          'plan',
        ),
    );

    this.shoppingBatcher = new NotificationBatcher<BatchedShoppingEvent>(
      { windowMs: SHOPPING_BATCH_WINDOW_MS, maxWaitMs: SHOPPING_BATCH_MAX_MS },
      (_key, events) => this.flushShoppingBatch(events),
      (_key, events) =>
        this.resolveDeferralMs(
          events[0].householdId,
          events[0].changedByUserId,
          'shopping',
        ),
    );
  }

  onModuleDestroy(): void {
    this.planBatcher.dispose();
    this.shoppingBatcher.dispose();
  }

  async registerDevice(params: {
    userId: string;
    deviceToken: string;
    platform?: PushPlatform;
    appBundleId?: string;
  }): Promise<{ success: boolean; pushEnabled: boolean }> {
    const normalizedToken = this.normalizeDeviceToken(params.deviceToken);
    if (!normalizedToken) {
      return { success: false, pushEnabled: this.apnsService.isConfigured() };
    }

    await this.prisma.pushDevice.upsert({
      where: { deviceToken: normalizedToken },
      create: {
        userId: params.userId,
        deviceToken: normalizedToken,
        platform: params.platform ?? PushPlatform.IOS,
        appBundleId:
          params.appBundleId ?? process.env.APNS_BUNDLE_ID ?? 'weeklymeals',
        isActive: true,
        lastSeenAt: new Date(),
      },
      update: {
        userId: params.userId,
        platform: params.platform ?? PushPlatform.IOS,
        appBundleId:
          params.appBundleId ?? process.env.APNS_BUNDLE_ID ?? 'weeklymeals',
        isActive: true,
        lastSeenAt: new Date(),
      },
    });

    // `pushEnabled` mówi klientowi, czy serwer W OGÓLE umie wysłać pusha —
    // bez tego iOS nie wie, czy może zrezygnować z własnych lokalnych
    // powiadomień. Odpowiedź „zarejestrowałem token" tego nie rozstrzyga:
    // token zapisuje się także wtedy, gdy APNs jest wyłączony w środowisku.
    return { success: true, pushEnabled: this.apnsService.isConfigured() };
  }

  /**
   * Zmiana w planie tygodniowym. NIE wysyła — dokłada do paczki.
   *
   * Kiedyś ta metoda wołała APNs wprost i to jest cała historia „spamu":
   * jedna kratka planu to jedno wywołanie `weeklyPlans:upsertWeekSlot`, więc
   * ułożenie tygodnia oznaczało kilkanaście osobnych powiadomień u drugiego
   * domownika. Teraz zdarzenia lądują w buforze i wychodzą jako jedno zdanie.
   */
  enqueueWeeklyPlanChange(params: {
    householdId: string;
    changedByUserId: string;
    changedByDisplayName?: string | null;
    action?: PlanChangeAction;
    context?: {
      dayOfWeek?: string | null;
      mealType?: string | null;
      weekStart?: string | null;
    };
  }): void {
    if (!this.apnsService.isConfigured()) {
      return;
    }

    const weekStart = params.context?.weekStart ?? '';
    const key = `plan|${params.householdId}|${weekStart}|${params.changedByUserId}`;

    this.planBatcher.enqueue(key, {
      householdId: params.householdId,
      changedByUserId: params.changedByUserId,
      changedByDisplayName: params.changedByDisplayName,
      action: params.action ?? 'UPDATE',
      weekStart: params.context?.weekStart,
      dayOfWeek: params.context?.dayOfWeek,
      mealType: params.context?.mealType,
    });
  }

  /**
   * Zmiana na liście zakupów. Też przez bufor — odhaczanie produktów przy
   * półce w sklepie to najgęstszy strumień zdarzeń w całej aplikacji.
   */
  enqueueShoppingListChange(params: {
    householdId: string;
    changedByUserId: string;
    changedByDisplayName?: string | null;
    action?: ShoppingChangeAction;
    isChecked?: boolean | null;
  }): void {
    if (!this.apnsService.isConfigured()) {
      return;
    }

    const key = `shopping|${params.householdId}|${params.changedByUserId}`;
    this.shoppingBatcher.enqueue(key, {
      householdId: params.householdId,
      changedByUserId: params.changedByUserId,
      changedByDisplayName: params.changedByDisplayName,
      action: params.action ?? 'UPDATE',
      isChecked: params.isChecked,
    });
  }

  /**
   * Nowy domownik albo odejście domownika — wysyłane OD RAZU, z pominięciem
   * bufora i ciszy nocnej.
   *
   * To jedyne powiadomienie w aplikacji, na które ktoś realnie czeka:
   * wysyłasz zaproszenie i chcesz wiedzieć, że po drugiej stronie ktoś je
   * przyjął. Zbieranie go w paczkę albo odkładanie do rana zamieniłoby
   * jedyną wartościową wiadomość w kolejną odłożoną.
   */
  async notifyHouseholdMembershipChanged(params: {
    householdId: string;
    actorUserId: string;
    actorDisplayName?: string | null;
    householdName?: string | null;
    action: 'JOINED' | 'LEFT';
  }): Promise<void> {
    if (!this.apnsService.isConfigured()) {
      return;
    }

    const copy =
      params.action === 'JOINED'
        ? buildHouseholdJoinedCopy(
            params.actorDisplayName,
            params.householdName,
          )
        : buildHouseholdLeftCopy(params.actorDisplayName, params.householdName);

    await this.sendToHousehold({
      householdId: params.householdId,
      excludeUserId: params.actorUserId,
      channel: 'household',
      payload: {
        ...copy,
        data: {
          householdId: params.householdId,
          type: 'HOUSEHOLD_MEMBERS_CHANGED',
          action: params.action,
        },
        threadId: this.threadId(params.householdId),
        // Bez collapse-id: dwoje różnych ludzi dołączających do gospodarstwa to
        // dwie osobne wiadomości, a nie aktualizacja tej samej.
        interruptionLevel: 'active',
        priority: 10,
        sound: 'default',
      },
    });
  }

  /**
   * Zaproszenie do gospodarstwa czeka w skrzynce adresata.
   *
   * Wysyłane w chwili, gdy zaproszenie zostaje do niego przypisane — czyli
   * kiedy pierwszy raz otworzy link. To jest cała odpowiedź na „zaprosiłem,
   * a jemu nic nie przyszło": dotąd zaproszenie żyło wyłącznie jako URL
   * w komunikatorze i po zamknięciu okienka nie zostawało po nim nic ani
   * w aplikacji, ani w Centrum powiadomień.
   *
   * Adresat w tym momencie patrzy w aplikację, więc klient celowo NIE robi
   * z tego bannera (`willPresent` odsyła `.list`) — powiadomienie ma być
   * śladem do odnalezienia później, a nie krzykiem o czymś, co widać na
   * ekranie.
   */
  async notifyHouseholdInvitation(params: {
    invitedUserId: string;
    householdId: string;
    householdName?: string | null;
    invitedByDisplayName?: string | null;
  }): Promise<void> {
    if (!this.apnsService.isConfigured()) {
      return;
    }

    const copy = buildHouseholdInvitationCopy(
      params.invitedByDisplayName,
      params.householdName,
    );

    await this.sendToUsers({
      userIds: [params.invitedUserId],
      channel: 'household',
      payload: {
        ...copy,
        data: {
          householdId: params.householdId,
          type: 'HOUSEHOLD_INVITATION',
          action: 'RECEIVED',
        },
        threadId: this.threadId(params.householdId),
        // Jedno zaproszenie na gospodarstwo — ponowne podejrzenie linku ma
        // podmienić poprzednie powiadomienie, a nie dołożyć drugie.
        collapseId: `invitation-${params.householdId}`,
        interruptionLevel: 'active',
        priority: 10,
        sound: 'default',
      },
    });
  }

  // MARK: - Wysyłka paczek

  private async flushPlanBatch(events: BatchedPlanEvent[]): Promise<void> {
    if (!events.length) return;
    const first = events[0];
    const copy = buildPlanSummary(first.changedByDisplayName, events);
    const weekStart = events.find((e) => e.weekStart)?.weekStart ?? '';

    await this.sendToHousehold({
      householdId: first.householdId,
      excludeUserId: first.changedByUserId,
      channel: 'plan',
      payload: {
        ...copy,
        data: {
          householdId: first.householdId,
          type: 'WEEKLY_PLAN_CHANGED',
          weekStart,
          changeCount: String(events.length),
        },
        // Kolejne podsumowanie tego samego tygodnia PODMIENIA poprzednie na
        // ekranie blokady zamiast stawać obok. Bez tego wieczorne poprawki
        // planu układałyby się w kolumnę powiadomień o tej samej treści.
        collapseId: `plan-${first.householdId}-${weekStart}`,
        threadId: this.threadId(first.householdId),
        // Podsumowanie planu ma być widoczne: baner i dźwięk. Przed spamem
        // chroni już bufor (jedno zdanie na całą sesję planowania) plus
        // collapse-id — `passive` z priorytetem 5 chował pusha bezgłośnie
        // w Centrum powiadomień i domownicy mieli wrażenie, że powiadomienia
        // w ogóle nie przychodzą.
        interruptionLevel: 'active',
        priority: 10,
        sound: 'default',
        expirationSeconds: SUMMARY_EXPIRATION_SECONDS,
      },
    });
  }

  private async flushShoppingBatch(
    events: BatchedShoppingEvent[],
  ): Promise<void> {
    if (!events.length) return;
    const first = events[0];
    const copy = buildShoppingSummary(first.changedByDisplayName, events);
    if (!copy) {
      return;
    }

    await this.sendToHousehold({
      householdId: first.householdId,
      excludeUserId: first.changedByUserId,
      channel: 'shopping',
      payload: {
        ...copy,
        data: {
          householdId: first.householdId,
          type: 'SHOPPING_LIST_CHANGED',
          changeCount: String(events.length),
        },
        collapseId: `shopping-${first.householdId}`,
        threadId: this.threadId(first.householdId),
        interruptionLevel: 'passive',
        priority: 5,
        sound: null,
        expirationSeconds: SUMMARY_EXPIRATION_SECONDS,
      },
    });
  }

  /** Jeden wątek na gospodarstwo — iOS zwija wtedy wszystko w jeden stos. */
  private threadId(householdId: string): string {
    return `household-${householdId}`;
  }

  // MARK: - Adresaci

  private async resolveRecipients(
    householdId: string,
    excludeUserId: string,
    channel: NotificationChannel,
  ): Promise<Recipient[]> {
    const memberships = await this.prisma.membership.findMany({
      where: {
        householdId,
        userId: { not: excludeUserId },
      },
      // Kolejność bez znaczenia — liczy się tylko zbiór adresatów.
      select: {
        userId: true,
        user: {
          select: {
            preferences: {
              select: {
                pushPlanChanges: true,
                pushShoppingList: true,
                pushHousehold: true,
                pushQuietHours: true,
                timeZone: true,
              },
            },
          },
        },
      },
    });

    return memberships
      .filter((membership) =>
        NotificationsService.allowsChannel(
          membership.user.preferences,
          channel,
        ),
      )
      .map((membership) => ({
        userId: membership.userId,
        quietHours: membership.user.preferences?.pushQuietHours ?? true,
        timeZone: membership.user.preferences?.timeZone ?? null,
      }));
  }

  /**
   * Czy ten użytkownik chce powiadomień z danego kanału.
   *
   * Brak wiersza preferencji = konto sprzed wprowadzenia tych kolumn.
   * Traktujemy je jak zgodę na wszystko, bo dokładnie tak zachowywało się
   * dotąd — sama migracja nie może nikogo po cichu wyciszyć.
   */
  private static allowsChannel(
    prefs: {
      pushPlanChanges: boolean;
      pushShoppingList: boolean;
      pushHousehold: boolean;
    } | null,
    channel: NotificationChannel,
  ): boolean {
    if (!prefs) return true;
    switch (channel) {
      case 'plan':
        return prefs.pushPlanChanges;
      case 'shopping':
        return prefs.pushShoppingList;
      case 'household':
        return prefs.pushHousehold;
    }
  }

  /** Odsiewa użytkowników, którzy wyciszyli dany kanał. */
  private async filterByChannelPreference(
    userIds: string[],
    channel: NotificationChannel,
  ): Promise<string[]> {
    if (!userIds.length) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true,
        preferences: {
          select: {
            pushPlanChanges: true,
            pushShoppingList: true,
            pushHousehold: true,
          },
        },
      },
    });
    return users
      .filter((user) =>
        NotificationsService.allowsChannel(user.preferences, channel),
      )
      .map((user) => user.id);
  }

  /**
   * Ile odczekać z wysyłką paczki. `0` = wysyłaj teraz.
   *
   * Cisza nocna liczy się per odbiorca, ale decyzja jest wspólna dla całej
   * paczki, bo paczka to jedna wiadomość. Odkładamy ją tylko wtedy, gdy KAŻDY
   * adresat śpi — jeśli choć jedna osoba nie ma nocy, wysyłamy od razu, a ten,
   * kto śpi, dostaje powiadomienie bezgłośne i bez zapalania ekranu
   * (`interruption-level: passive`), więc i tak go nie obudzi.
   */
  private async resolveDeferralMs(
    householdId: string,
    excludeUserId: string,
    channel: NotificationChannel,
  ): Promise<number> {
    const recipients = await this.resolveRecipients(
      householdId,
      excludeUserId,
      channel,
    );
    if (!recipients.length) {
      return 0;
    }

    const now = new Date();
    const deferrals = recipients.map((recipient) =>
      recipient.quietHours ? quietHoursDeferralMs(now, recipient.timeZone) : 0,
    );

    if (deferrals.some((value) => value === 0)) {
      return 0;
    }
    return Math.min(...deferrals);
  }

  private async sendToHousehold(params: {
    householdId: string;
    excludeUserId: string;
    channel: NotificationChannel;
    payload: PushPayload;
  }): Promise<void> {
    const recipients = await this.resolveRecipients(
      params.householdId,
      params.excludeUserId,
      params.channel,
    );
    // Bez ponownego filtrowania kanału — `resolveRecipients` już to zrobiło
    // i po drodze policzyło ciszę nocną.
    await this.sendToDevices(
      recipients.map((recipient) => recipient.userId),
      params.channel,
      params.payload,
    );
  }

  /**
   * Wysyłka do konkretnych użytkowników, z pominięciem drogi przez
   * gospodarstwo. Zaproszenie jest jedynym powiadomieniem, które nie ma
   * gospodarstwa jako adresata — jego adresat DOPIERO ma do niego dołączyć.
   */
  private async sendToUsers(params: {
    userIds: string[];
    channel: NotificationChannel;
    payload: PushPayload;
  }): Promise<void> {
    const userIds = await this.filterByChannelPreference(
      params.userIds,
      params.channel,
    );
    await this.sendToDevices(userIds, params.channel, params.payload);
  }

  private async sendToDevices(
    userIds: string[],
    channel: NotificationChannel,
    payload: PushPayload,
  ): Promise<void> {
    if (!userIds.length) {
      return;
    }

    const devices = await this.prisma.pushDevice.findMany({
      where: {
        userId: { in: userIds },
        isActive: true,
        platform: PushPlatform.IOS,
      },
      select: { id: true, deviceToken: true, appBundleId: true },
    });

    if (!devices.length) {
      return;
    }

    await Promise.all(
      devices.map(async (device) => {
        try {
          await this.apnsService.sendToDevice(
            device.deviceToken,
            payload,
            device.appBundleId,
          );
        } catch (error) {
          if (this.shouldDeactivateToken(error)) {
            // Głośno, nie po cichu: BadDeviceToken/DeviceTokenNotForTopic
            // potrafi dotyczyć KAŻDEGO urządzenia naraz (zły APNS_USE_SANDBOX
            // albo topic z klienta) i bez tego logu wygląda jak „nikt nic
            // nie planował", a nie jak masowa dezaktywacja.
            this.logger.warn(
              `APNs token deactivated (${channel}) tail=${device.deviceToken.slice(-8)}: ${(error as Error).message}`,
            );
            await this.prisma.pushDevice.update({
              where: { id: device.id },
              data: { isActive: false },
            });
            return;
          }
          this.logger.warn(
            `APNs send failed (${channel}) for token tail=${device.deviceToken.slice(-8)}: ${(error as Error).message}`,
          );
        }
      }),
    );
  }

  private normalizeDeviceToken(token: string): string {
    return token.replace(/[<>\s]/g, '').trim();
  }

  private shouldDeactivateToken(error: unknown): boolean {
    if (!(error instanceof ApnsSendError)) {
      return false;
    }

    if (error.status === 410 || error.status === 404) {
      return true;
    }

    const body = error.responseBody ?? '';
    return (
      body.includes('BadDeviceToken') ||
      body.includes('Unregistered') ||
      body.includes('DeviceTokenNotForTopic')
    );
  }
}
