import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AppleJwsError } from '../../billing/apple-jws.verifier';
import { SubscriptionsService } from '../../billing/subscriptions.service';
import { AppException } from '../../common/app-exception';
import { PrismaService } from '../../prisma/prisma.service';
import type { AppleNotification, SubscriptionsData } from '../contract';
import { readOnlyQuery } from '../read-only-query';
import { ADMIN_PRODUCT_IDS, isAdminProductId } from './admin-products';
import {
  carriesRevenue,
  compareRisk,
  endedAt,
  liveNow,
  mrrAt,
  mrrSeriesPoints,
  oneMonthEarlier,
  percentChange,
  revenueSpans,
  riskSignal,
  roundMoney,
  type MetricSubscription,
  type RiskSignal,
} from './subscription-metrics';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Okno ruchu: ostatnie 30 dni kroczące, porównane z 30 dniami wcześniej. */
const MOVEMENT_WINDOW_MS = 30 * DAY_MS;
/** Dziennik powiadomień Apple na ekranie. */
export const NOTIFICATIONS_LIMIT = 50;
/** Tabela ryzyka — więcej wierszy to już raport, nie lista do obdzwonienia. */
export const RISK_LIMIT = 100;

/**
 * `notificationUUID` od Apple to UUID, ale kolumna jest tekstem bez walidacji
 * formatu przy zapisie (`recordNotification` bierze napis z podpisanego
 * ładunku), więc bramka sprawdza bezpieczny KSZTAŁT, nie wersję UUID —
 * `assertUuid` odrzuciłby wiersz, którego Apple nie wygenerowało jako v1–v8.
 */
const NOTIFICATION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function assertNotificationId(raw: unknown): string {
  if (typeof raw !== 'string' || !NOTIFICATION_ID.test(raw)) {
    const detail = 'id must be an Apple notificationUUID';
    throw new AppException('VALIDATION_ERROR', detail, HttpStatus.BAD_REQUEST, [
      detail,
    ]);
  }
  return raw;
}

const METRIC_SELECT = {
  id: true,
  provider: true,
  productId: true,
  status: true,
  environment: true,
  ownershipType: true,
  expiresAt: true,
  graceExpiresAt: true,
  neverExpires: true,
  revokedAt: true,
  operatorHoldAt: true,
  autoRenewStatus: true,
  messagesLimitSnapshot: true,
  plansLimitSnapshot: true,
  purchaserUserId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SubscriptionSelect;

/** Bez `signedPayload` — surowy ładunek Apple nie wychodzi do panelu. */
const NOTIFICATION_SELECT = {
  notificationUuid: true,
  notificationType: true,
  subtype: true,
  originalTransactionId: true,
  environment: true,
  receivedAt: true,
  processedAt: true,
  attempts: true,
  error: true,
} satisfies Prisma.AppleNotificationSelect;

export type NotificationRetry = {
  notificationType: string;
  /** Powód, z którym domena zamknęła zdarzenie (np. „Subskrypcja jeszcze nieznana."). */
  note: string | null;
};

/**
 * Subskrypcje i przychód w panelu (ROADMAPA §5.6). Liczby na żywo z wierszy
 * `Subscription` i dziennika `AppleNotification`; arytmetyka w
 * `subscription-metrics.ts`. Ponowienie powiadomienia idzie przez
 * `SubscriptionsService.processNotification` — tę samą metodę, której używa
 * webhook i godzinny przebieg uzgadniania.
 */
@Injectable()
export class AdminSubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  async data(now: Date = new Date()): Promise<SubscriptionsData> {
    const series = mrrSeriesPoints(now);
    const monthAgo = oneMonthEarlier(now);
    const windowStart = new Date(now.getTime() - MOVEMENT_WINDOW_MS);
    const previousStart = new Date(now.getTime() - 2 * MOVEMENT_WINDOW_MS);
    // Najwcześniejsza chwila, o którą pyta ekran. Wiersz, który przestał
    // płacić wcześniej, nie zmienia żadnej liczby, więc nie ma po co go czytać.
    const earliest = new Date(
      Math.min(
        series[0]?.at.getTime() ?? now.getTime(),
        monthAgo.getTime(),
        previousStart.getTime(),
      ),
    );

    return readOnlyQuery(this.prisma, async (tx) => {
      // Nadzbiór wierszy, które mogły płacić w `earliest` albo później: koniec
      // płacenia (`endedAt`) to zawsze jedna z tych dat albo `updatedAt`.
      const rows: MetricSubscription[] = await tx.subscription.findMany({
        where: {
          provider: 'APPLE',
          OR: [
            { status: { in: ['ACTIVE', 'GRACE'] } },
            { expiresAt: { gte: earliest } },
            { graceExpiresAt: { gte: earliest } },
            { revokedAt: { gte: earliest } },
            { operatorHoldAt: { gte: earliest } },
            { updatedAt: { gte: earliest } },
          ],
        },
        select: METRIC_SELECT,
      });

      // ODNOWIENIA Z DZIENNIKA APPLE. Wiersz `Subscription` trzyma tylko stan
      // bieżący — odnowienie przesuwa `expiresAt` i nie zostawia śladu.
      // `DID_RENEW` (także z podtypem BILLING_RECOVERY) to jedyny zapis, że
      // okres się odnowił. Nie odróżnia Chmury Rodzinnej (to jest w podpisanym
      // ładunku, którego panel nie czyta) — przy wyłączonym
      // `APPLE_ACCEPT_FAMILY_SHARED` takich zdarzeń i tak nie ma w obiegu.
      const renewalsWhere = {
        notificationType: 'DID_RENEW',
        environment: 'Production',
      } satisfies Prisma.AppleNotificationWhereInput;
      const renewals = await tx.appleNotification.count({
        where: { ...renewalsWhere, receivedAt: { gte: windowStart } },
      });
      const renewalsBefore = await tx.appleNotification.count({
        where: {
          ...renewalsWhere,
          receivedAt: { gte: previousStart, lt: windowStart },
        },
      });

      const spans = revenueSpans(rows, now);
      const mrrZl = mrrAt(spans, now);

      const revenueRows = rows.filter(carriesRevenue);
      const createdBetween = (from: Date, to: Date | null) =>
        revenueRows.filter(
          (row) =>
            row.createdAt.getTime() >= from.getTime() &&
            (to === null || row.createdAt.getTime() < to.getTime()),
        ).length;
      // Odejście = wiersz, który JEST dziś EXPIRED/REVOKED i przestał płacić
      // w oknie. Kto odszedł i wrócił na tej samej umowie, odejściem już nie
      // jest (wiersz znów żyje) — przybliżenie bez historii stanów.
      const churnedBetween = (from: Date, to: Date | null) =>
        revenueRows.filter((row) => {
          if (row.status !== 'EXPIRED' && row.status !== 'REVOKED') {
            return false;
          }
          const end = endedAt(row, now);
          return (
            end !== null &&
            end.getTime() >= from.getTime() &&
            (to === null || end.getTime() < to.getTime())
          );
        }).length;
      const newSubs = createdBetween(windowStart, null);
      const churned = churnedBetween(windowStart, null);

      // „Aktywne subskrypcje" to żywe wiersze App Store z produkcji — z
      // Chmurą Rodzinną (panel pokazuje ją jako część całości), bez nadań
      // ręcznych i bez Sandboxa, który ma własny licznik.
      const liveProduction = rows.filter(
        (row) => row.environment === 'Production' && liveNow(row, now),
      );

      const risk = await this.risk(tx, rows, now);
      const notifications = await this.notifications(tx);

      return {
        mrrZl,
        arrZl: roundMoney(mrrZl * 12),
        mrrTrend: percentChange(mrrZl, mrrAt(spans, monthAgo)),
        mrrSeries: series.map((point) => ({
          month: point.month,
          value: mrrAt(spans, point.at),
        })),
        movement: {
          newSubs,
          renewals,
          churned,
          trends: [
            percentChange(newSubs, createdBetween(previousStart, windowStart)),
            percentChange(renewals, renewalsBefore),
            percentChange(churned, churnedBetween(previousStart, windowStart)),
          ],
        },
        byProduct: ADMIN_PRODUCT_IDS.map((productId) => ({
          productId,
          count: liveProduction.filter((row) => row.productId === productId)
            .length,
        })),
        familyShared: liveProduction.filter(
          (row) =>
            row.ownershipType === 'FAMILY_SHARED' &&
            isAdminProductId(row.productId),
        ).length,
        sandbox: rows.filter(
          (row) => row.environment === 'Sandbox' && liveNow(row, now),
        ).length,
        risk,
        notifications,
      };
    });
  }

  /**
   * Ponowne przetworzenie powiadomienia Apple — przez
   * `SubscriptionsService.processNotification`, jak webhook i przebieg
   * uzgadniania. Panel nie ma własnej ścieżki: strażnik kolejności, zapis
   * warunkowy i maile o zmianie stanu działają tak samo jak przy pierwszym
   * odbiorze. Działa także na zdarzeniach, na które przebieg już machnął
   * ręką (`attempts ≥ 10`) — po to jest ten przycisk.
   */
  async retryNotification(uuid: string): Promise<NotificationRetry> {
    const row = await this.prisma.appleNotification.findUnique({
      where: { notificationUuid: uuid },
      select: { processedAt: true, notificationType: true },
    });
    if (!row) {
      throw new AppException(
        'NOT_FOUND',
        'Nie ma takiego powiadomienia Apple.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (row.processedAt) {
      // Drugie przetworzenie tego samego zdarzenia potrafiłoby cofnąć nowszy
      // stan — dlatego domena go nie robi, a panel mówi to wprost.
      throw new AppException(
        'CONFLICT',
        'To powiadomienie jest już przetworzone.',
        HttpStatus.CONFLICT,
      );
    }
    try {
      await this.subscriptions.processNotification(uuid);
    } catch (error) {
      // Domena zapisała już błąd w wierszu i podbiła `attempts`. Podpis,
      // którego nie da się potwierdzić, to nie awaria serwera — 422 z kodem.
      if (error instanceof AppleJwsError) {
        throw new AppException(
          'BILLING_NOTIFICATION_INVALID',
          `Nie udało się potwierdzić podpisu powiadomienia (${error.code}).`,
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      throw error;
    }
    const after = await this.prisma.appleNotification.findUnique({
      where: { notificationUuid: uuid },
      select: { error: true },
    });
    return {
      notificationType: row.notificationType,
      note: after?.error ?? null,
    };
  }

  /**
   * Osoby z płacącą subskrypcją zagrożoną odejściem — po jednym wierszu na
   * osobę (klucz tabeli w panelu to `userId`), z najpoważniejszym powodem.
   * Wiersz bez konta płatnika (skasowane — `purchaserUserId` to `SetNull`)
   * nie ma do kogo prowadzić i odpada.
   */
  private async risk(
    tx: Prisma.TransactionClient,
    rows: readonly MetricSubscription[],
    now: Date,
  ): Promise<SubscriptionsData['risk']> {
    const byUser = new Map<string, RiskSignal>();
    for (const row of rows) {
      if (!row.purchaserUserId) continue;
      const signal = riskSignal(row, now);
      if (!signal) continue;
      const current = byUser.get(row.purchaserUserId);
      if (!current || compareRisk(signal, current) < 0) {
        byUser.set(row.purchaserUserId, signal);
      }
    }
    if (byUser.size === 0) return [];
    const users = await tx.user.findMany({
      where: { id: { in: [...byUser.keys()] } },
      select: { id: true, displayName: true },
    });
    const names = new Map(users.map((user) => [user.id, user.displayName]));
    return [...byUser.entries()]
      .flatMap(([userId, signal]) => {
        const name = names.get(userId);
        return name === undefined ? [] : [{ userId, name, signal }];
      })
      .sort(
        (a, b) =>
          compareRisk(a.signal, b.signal) || a.name.localeCompare(b.name, 'pl'),
      )
      .slice(0, RISK_LIMIT)
      .map(({ userId, name, signal }) => ({
        userId,
        name,
        productId: signal.productId,
        kind: signal.kind,
        until: signal.until?.toISOString() ?? null,
      }));
  }

  /**
   * Ostatnie powiadomienia, NIEPRZETWORZONE NAJPIERW — także starsze niż
   * najnowsza pięćdziesiątka: zaległe zdarzenie to właśnie to, co trzeba
   * zobaczyć i ponowić. Płatnik po `originalTransactionId`; zdarzenie o
   * subskrypcji, której u nas nie ma (albo płatnik skasował konto) — `null`.
   */
  private async notifications(
    tx: Prisma.TransactionClient,
  ): Promise<AppleNotification[]> {
    const pending = await tx.appleNotification.findMany({
      where: { processedAt: null },
      orderBy: [{ receivedAt: 'desc' }, { notificationUuid: 'asc' }],
      take: NOTIFICATIONS_LIMIT,
      select: NOTIFICATION_SELECT,
    });
    const processed =
      pending.length < NOTIFICATIONS_LIMIT
        ? await tx.appleNotification.findMany({
            where: { processedAt: { not: null } },
            orderBy: [{ receivedAt: 'desc' }, { notificationUuid: 'asc' }],
            take: NOTIFICATIONS_LIMIT - pending.length,
            select: NOTIFICATION_SELECT,
          })
        : [];
    const rows = [...pending, ...processed];

    const transactionIds = [
      ...new Set(
        rows
          .map((row) => row.originalTransactionId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const payers = transactionIds.length
      ? await tx.subscription.findMany({
          where: { originalTransactionId: { in: transactionIds } },
          select: {
            originalTransactionId: true,
            purchaser: { select: { displayName: true } },
          },
        })
      : [];
    const payerOf = new Map(
      payers.map((payer) => [
        payer.originalTransactionId,
        payer.purchaser?.displayName ?? null,
      ]),
    );

    return rows.map((row) => ({
      notificationUuid: row.notificationUuid,
      notificationType: row.notificationType,
      subtype: row.subtype,
      // Powiadomienie zbiorcze (`summary` zamiast `data`) nie niesie
      // środowiska. Kontrakt zna dwa; Sandbox oznaczamy tylko wtedy, gdy
      // wiersz mówi to wprost, a panel dopisuje etykietę wyłącznie Sandboxowi.
      environment: row.environment === 'Sandbox' ? 'Sandbox' : 'Production',
      userName: row.originalTransactionId
        ? (payerOf.get(row.originalTransactionId) ?? null)
        : null,
      receivedAt: row.receivedAt.toISOString(),
      processedAt: row.processedAt?.toISOString() ?? null,
      attempts: row.attempts,
      error: row.error,
    }));
  }
}
