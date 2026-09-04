import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { AppException } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { OpsTokenGuard } from '../observability/ops-token.guard';
import { SUBSCRIPTION_PRODUCTS } from '../config/subscription-products';
import { subscriptionScopeId } from '../config/purchase-identity';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionsReconcileService } from './subscriptions-reconcile.service';

/**
 * Obsługa klienta po stronie operatora — wszystko za `x-ops-token`.
 *
 * PO CO TO ISTNIEJE. Audyt wskazał dwie sytuacje, w których bez tych
 * endpointów zostawało tylko wejście do bazy z ręki:
 *   • „zapłaciłem i nie mam PRO" — trzeba móc zobaczyć, co Apple o tym mówi,
 *     i wymusić uzgodnienie bez czekania na kolejny przebieg;
 *   • „sufit kosztu domu mnie odciął" — płacący klient blokuje się na naszym
 *     bezpieczniku, a bezpiecznik nie miał żadnego przycisku zwalniającego.
 *
 * Nadanie ręczne (`MANUAL`) obsługuje trzeci przypadek: konto recenzenta App
 * Store, rekompensata i rodzina testująca. Nie chodzi przez Apple, więc nie ma
 * `originalTransactionId` i nie jest uzgadniane.
 */

export class GrantManualDto {
  /** Hasz tożsamości obdarowanej osoby (z `GET /ops/billing/subscriptions`). */
  @IsString()
  identityHash!: string;

  @IsString()
  productId!: string;

  /** Na ile miesięcy; 0 = bezterminowo (konto recenzenta). */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(60)
  months!: number;
}

export class LookupQueryDto {
  @IsOptional()
  @IsString()
  originalTransactionId?: string;

  @IsOptional()
  @IsString()
  userId?: string;
}

@Controller('ops/billing')
@UseGuards(OpsTokenGuard)
export class BillingOpsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionsService,
    private readonly reconciler: SubscriptionsReconcileService,
  ) {}

  /** Wyszukanie subskrypcji po transakcji Apple albo po koncie. */
  @Get('subscriptions')
  async lookup(@Query() query: LookupQueryDto) {
    if (query.userId) {
      return { subscriptions: await this.subscriptions.forUser(query.userId) };
    }
    if (!query.originalTransactionId) {
      throw new AppException(
        'VALIDATION_ERROR',
        'Podaj originalTransactionId albo userId.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const row = await this.prisma.subscription.findUnique({
      where: { originalTransactionId: query.originalTransactionId },
    });
    return { subscription: row ?? null };
  }

  /** Wymuszone uzgodnienie z Apple dla jednej subskrypcji. */
  @Post('subscriptions/:id/reconcile')
  async reconcile(@Param('id') id: string) {
    return { reconciled: await this.subscriptions.reconcile(id) };
  }

  /** Cały przebieg od ręki: zaległe zdarzenia + nieświeże subskrypcje. */
  @Post('sweep')
  async sweep() {
    return this.reconciler.sweep();
  }

  /**
   * Odebranie dostępu po zwrocie pieniędzy, gdy powiadomienie nie doszło.
   *
   * Bez tego degradacja po zwrocie była cichym no-opem: operator „coś klikał",
   * a `resolvePlan` dalej widziało ACTIVE z datą w przyszłości.
   */
  @Post('subscriptions/:id/revoke')
  async revoke(@Param('id') id: string) {
    const updated = await this.prisma.subscription.updateMany({
      where: { id },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    if (updated.count === 0) {
      throw new AppException(
        'NOT_FOUND',
        'Nie znaleziono subskrypcji.',
        HttpStatus.NOT_FOUND,
      );
    }
    return { revoked: true };
  }

  /**
   * Nadanie ręczne: konto recenzenta App Store, rekompensata, rodzina
   * testująca. `MANUAL`, więc uzgadnianie z Apple je omija.
   */
  @Post('grant')
  async grant(@Body() dto: GrantManualDto) {
    const product = SUBSCRIPTION_PRODUCTS[dto.productId];
    if (!product) {
      throw new AppException(
        'VALIDATION_ERROR',
        `Nieznany produkt: ${dto.productId}.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const now = new Date();
    const expiresAt =
      dto.months > 0
        ? new Date(
            Date.UTC(
              now.getUTCFullYear(),
              now.getUTCMonth() + dto.months,
              now.getUTCDate(),
            ),
          )
        : null;
    const created = await this.prisma.subscription.create({
      data: {
        identityHash: dto.identityHash,
        provider: 'MANUAL',
        productId: dto.productId,
        status: 'ACTIVE',
        expiresAt,
        // Bezterminowe wolno TYLKO tutaj — dla APPLE brak daty znaczy „nie
        // wiemy", czyli martwa.
        neverExpires: dto.months === 0,
        messagesLimitSnapshot: product.messagesPerMonth,
        plansLimitSnapshot: product.plansPerMonth,
        lastVerifiedAt: now,
      },
    });
    return { subscriptionId: created.id, expiresAt, product: product.name };
  }

  /**
   * Zwolnienie sufitu kosztu miesięcznego gospodarstwa.
   *
   * Sufit (`AI_HOUSEHOLD_MONTHLY_COST_USD`) jest bezpiecznikiem przed pętlą
   * błędów, a nie limitem sprzedanym klientowi — więc gdy odetnie kogoś, kto
   * mieści się w tym, co kupił, musi istnieć sposób, żeby go zwolnić bez
   * wchodzenia do bazy.
   */
  @Post('households/:id/cost-reset')
  async resetCost(@Param('id') householdId: string) {
    const periodKey = new Date().toISOString().slice(0, 7);
    const result = await this.prisma.aiUsageCounter.updateMany({
      where: { scopeId: householdId, periodKey, kind: 'costMicroUsd' },
      data: { value: 0 },
    });
    return { reset: result.count, periodKey };
  }

  /**
   * Podgląd zużycia w zakresie subskrypcji — do odpowiedzi na „ile mi zostało",
   * gdy klient pyta przez wsparcie, a nie przez aplikację.
   */
  @Get('subscriptions/:id/usage')
  async usage(@Param('id') id: string) {
    const periodKey = new Date().toISOString().slice(0, 7);
    const rows = await this.prisma.aiUsageCounter.findMany({
      where: { scopeId: subscriptionScopeId(id), periodKey },
      select: { kind: true, value: true },
    });
    return { periodKey, counters: rows };
  }
}
